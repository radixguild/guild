use guild_marketplace_escrow::{
    ArbiterBadgeData, EntitledParty,
    AcceptedTokenConfig, AutoResolveDefault, DisputeParty, DisputeRuling, TaskInfo, TaskState,
};
use scrypto_test::prelude::*;

const HUMAN_DEADLINE_SECS: u64 = 604_800;
const AGENT_DEADLINE_SECS: u64 = 86_400;
/// D-P3 grace window. Non-zero on purpose: a zero here would silently restore
/// the first-to-commit late-submit race and every grace test would still pass.
const EXPIRE_GRACE_SECS: u64 = 3_600;
/// Reward-TOKEN units since stage 5a (W4-mech): the bond is denominated in
/// `task.reward_token`, never XRD. The name would be a lie with `_XRD` on it.
const CLAIM_BOND: &str = "1";
/// A bond below one whole token. The old `min(1 XRD, bond)` bounty edge this
/// constant existed for is GONE — the bounty is a SHARE of the bond now
/// (`expire_bounty_pct`), so a proportional cut can never exceed the bond and
/// the sub-bounty cliff no longer exists. What a sub-unit bond still proves is
/// that the proportional split stays exact below 1.
const SUB_UNIT_BOND: &str = "0.9";
/// Fixture default for `expire_bounty_pct` — the sheet's deploy placeholder.
/// At the "live-sized" bond of 10 this pays the expire caller 1 and the house
/// 9, which deliberately preserves the arithmetic the DB-4 tests already pin.
const EXPIRE_BOUNTY_PCT: &str = "0.1";
/// W2 (stage 6): the poster's review window — D1's decided default of 3 days.
const REVIEW_WINDOW_SECS: u64 = 259_200;
/// The brief every fixture task commits (`create_task`'s work_brief_hash).
/// Non-zero deliberately: submit_task must present the SAME hash back (P4-3's
/// on-chain leg), and a zero brief would let the zero-evidence and
/// wrong-brief rejection tests shadow each other.
const WORK_BRIEF: Hash = Hash([0xB1; 32]);

struct Fixture {
    ledger: DefaultLedgerSimulator,
    owner_pk: Secp256k1PublicKey,
    owner_account: ComponentAddress,
    poster_pk: Secp256k1PublicKey,
    poster_account: ComponentAddress,
    worker_pk: Secp256k1PublicKey,
    worker_account: ComponentAddress,
    arbiter_pk: Secp256k1PublicKey,
    arbiter_account: ComponentAddress,
    escrow: ComponentAddress,
    owner_badge: ResourceAddress,
    royalty_admin_badge: ResourceAddress,
    worker_badge: ResourceAddress,
    arbiter_badge: ResourceAddress,
    reward_token: ResourceAddress,
    task_receipt_resource: ResourceAddress,
    claim_receipt_resource: ResourceAddress,
    claim_bond: Decimal,
}

fn setup() -> Fixture {
    // The suite's AMBIENT default == the DEPLOY default: SplitEvenly, per the
    // signed sheet (DB-1, sitting 2026-08-06 — restores D2, reverses D-P4).
    // Tests exercising the FavorDisputeRaiser or ReturnToPoster arms say so
    // explicitly via setup_with_default. If this line ever changes, the
    // SE-exact pins in test_disputing_never_out_earns_being_approved go red —
    // that is deliberate: the ambient default is load-bearing.
    setup_with_default(AutoResolveDefault::SplitEvenly)
}

fn setup_with_default(auto_default: AutoResolveDefault) -> Fixture {
    setup_full(auto_default, CLAIM_BOND)
}

/// Deploy-default ruling, custom FLAT bond — for tests whose property only
/// shows at a bond larger than the fixture's 1 (e.g. both legs of the expire
/// bounty split nonzero).
fn setup_with_bond(bond: &str) -> Fixture {
    setup_full(AutoResolveDefault::SplitEvenly, bond)
}

fn setup_full(auto_default: AutoResolveDefault, bond: &str) -> Fixture {
    setup_full_div(auto_default, bond, 18)
}

/// Fixture with REAL proportional bond params (pct/floor/cap), for the tests
/// that exercise `required_bond`'s clamping itself. Everything else runs the
/// flat-bond emulation `setup_full_div` builds (pct=0 → floor==cap==bond).
fn setup_bond_params(pct: &str, floor: &str, cap: &str, divisibility: u8) -> Fixture {
    setup_fixture(
        AutoResolveDefault::SplitEvenly,
        Decimal::from_str(pct).unwrap(),
        Decimal::from_str(floor).unwrap(),
        Decimal::from_str(cap).unwrap(),
        divisibility,
        ArbiterAssignee::TheArbiter,
    )
}

/// Whose account the arbiter badge's `assigned_account` (L3(b)) names.
/// The ambient fixture assigns it to the arbiter's own account — a neutral
/// third party. The other two arms exist for the L6(c) self-dealing tests:
/// worker-assigned must be REFUSED at resolve, poster-assigned must be
/// ACCEPTED (the trade (c) makes, kept visible by a test).
#[derive(Clone, Copy)]
enum ArbiterAssignee {
    TheArbiter,
    TheWorker,
    ThePoster,
}

fn setup_with_arbiter_assigned_to(assignee: ArbiterAssignee) -> Fixture {
    let flat = Decimal::from_str(CLAIM_BOND).unwrap();
    setup_fixture(AutoResolveDefault::SplitEvenly, Decimal::ZERO, flat, flat, 18, assignee)
}

/// Fixture with a reward token of a CHOSEN divisibility.
///
/// 🔴 Why this exists. Every other test in this suite runs an 18-decimal reward
/// token, which is the one case where `credit_split_for_parties`' rounding is a
/// NO-OP — an 18dp token can represent any product Decimal produces, so the
/// suite can be fully green while the rounding is never exercised at all.
/// Meanwhile every USD-pegged token on Radix worth paying anyone in is **6dp**
/// (measured 2026-08-29: xUSDC, hUSDC, hUSDT). So the token the guild is about
/// to switch rewards to is precisely the token no test covers.
fn setup_full_div(auto_default: AutoResolveDefault, bond: &str, divisibility: u8) -> Fixture {
    // FLAT-BOND EMULATION. Stage 5a made the bond proportional
    // (`clamp(pct * reward, floor, cap)`), which would have re-derived every
    // pinned amount in this suite. pct=0 forces the raw product to 0, which
    // clamps UP to the floor — so floor==cap==bond reproduces the old flat
    // bond exactly, in the reward token, and `f.claim_bond` stays truthful.
    // The clamping arithmetic itself is exercised by the setup_bond_params
    // tests, not smuggled untested through this emulation.
    let flat = Decimal::from_str(bond).unwrap();
    setup_fixture(auto_default, Decimal::ZERO, flat, flat, divisibility, ArbiterAssignee::TheArbiter)
}

fn setup_fixture(
    auto_default: AutoResolveDefault,
    claim_bond_pct: Decimal,
    claim_bond_floor: Decimal,
    claim_bond_cap: Decimal,
    divisibility: u8,
    arbiter_assignee: ArbiterAssignee,
) -> Fixture {
    let mut ledger = LedgerSimulatorBuilder::new().build();
    let (owner_pk, _, owner_account) = ledger.new_allocated_account();
    let (poster_pk, _, poster_account) = ledger.new_allocated_account();
    let (worker_pk, _, worker_account) = ledger.new_allocated_account();
    let (arbiter_pk, _, arbiter_account) = ledger.new_allocated_account();
    let package_address = ledger.compile_and_publish(this_package!());

    // Worker badge must be NON-FUNGIBLE so claim_task can read local_id
    // (claimer_badge_id) and raise_dispute can verify it.
    // create_non_fungible_resource mints 3 NFTs (ids 1, 2, 3) into the account.
    let worker_badge = ledger.create_non_fungible_resource(worker_account);

    // The ARBITER badge cannot use that helper any more: since the L6(c)
    // self-dealing guard, resolve_dispute DECODES the badge's non-fungible
    // data as ArbiterBadgeData (the mint contract), and the helper's generic
    // test data would panic the decode on every ruling. Minted here with the
    // real shape, `assigned_account` per the fixture's assignee — held by the
    // arbiter ACCOUNT in all three arms; what varies is whose identity the
    // badge carries, which is exactly what the guard reads.
    //
    // 🔴 NON-TRANSFERABLE, like the REAL badge (sheet row 2: withdrawer
    // DenyAll, forever). This is not fidelity for its own sake: the fixture
    // minted a default-TRANSFERABLE badge while resolve_dispute took the badge
    // as a Bucket, so the suite stayed green over a method the real
    // non-transferable badge could never call — caught at ceremony prep, not
    // by a test. With these roles, any bucket-shaped use of the badge fails
    // HERE, in CI, before it can ship uncallable again.
    let assigned_account = match arbiter_assignee {
        ArbiterAssignee::TheArbiter => arbiter_account,
        ArbiterAssignee::TheWorker => worker_account,
        ArbiterAssignee::ThePoster => poster_account,
    };
    let mint_arbiter = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .create_non_fungible_resource(
            OwnerRole::None,
            NonFungibleIdType::Integer,
            false,
            NonFungibleResourceRoles {
                withdraw_roles: withdraw_roles! {
                    withdrawer => rule!(deny_all);
                    withdrawer_updater => rule!(deny_all);
                },
                ..Default::default()
            },
            metadata!(),
            Some(btreemap!(
                NonFungibleLocalId::integer(1) => ArbiterBadgeData {
                    assigned_account,
                },
            )),
        )
        .try_deposit_entire_worktop_or_abort(arbiter_account, None)
        .build();
    let mint_receipt = ledger.execute_manifest(
        mint_arbiter,
        vec![NonFungibleGlobalId::from_public_key(&arbiter_pk)],
    );
    mint_receipt.expect_commit_success();
    let arbiter_badge = mint_receipt.expect_commit(true).new_resource_addresses()[0];
    // ⚠️ A NON-XRD reward token is STILL a deliberate safety property, but the
    // class it guards CHANGED at stage 5a. It used to keep the reward lane and
    // the (then-XRD) bond lane distinct resources so a lane mix-up was loud;
    // the bond is now denominated in the reward token BY DESIGN (W4-mech —
    // same-resource arithmetic dissolves the oracle problem), so resource
    // identity can no longer tell the two lanes apart ANYWHERE, tests
    // included. What the non-XRD token still catches: XRD from fees, the
    // faucet, or a future XRD-denominated field leaking into either lane, and
    // any code path that hardcodes XRD where it means the task's token. The
    // lane split itself is guarded the only way it still can be — per-lane
    // entitlement/vault asserts, never summed across lanes.
    let reward_token =
        ledger.create_fungible_resource(dec!("1000000"), divisibility, poster_account);

    // Stage 5a means the WORKER stakes the bond in the reward token, so the
    // worker needs some. Funded from the poster's mint; every balance assert
    // in the suite is a delta against a snapshot, so the baseline is inert.
    let fund_worker = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .withdraw_from_account(poster_account, reward_token, dec!("1000"))
        .try_deposit_entire_worktop_or_abort(worker_account, None)
        .build();
    ledger
        .execute_manifest(
            fund_worker,
            vec![NonFungibleGlobalId::from_public_key(&poster_pk)],
        )
        .expect_commit_success();

    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .call_function(
            package_address,
            "Escrow",
            "instantiate",
            manifest_args!(
                worker_badge,
                arbiter_badge,
                None::<ResourceAddress>,
                dec!("0.5"),
                HUMAN_DEADLINE_SECS,
                AGENT_DEADLINE_SECS,
                1_209_600u64,
                EXPIRE_GRACE_SECS,
                auto_default,
                dec!("0.05"),
                claim_bond_pct,
                claim_bond_floor,
                claim_bond_cap,
                Decimal::from_str(EXPIRE_BOUNTY_PCT).unwrap(),
                REVIEW_WINDOW_SECS,
            ),
        )
        .call_method(
            owner_account,
            "deposit_batch",
            manifest_args!(ManifestExpression::EntireWorktop),
        )
        .build();

    let receipt = ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&owner_pk)],
    );
    receipt.expect_commit_success();
    let commit = receipt.expect_commit(true);
    let escrow = commit.new_component_addresses()[0];
    // new_resource_addresses order on instantiate:
    // 0 owner_badge, 1 royalty_admin_badge, 2 internal_minter,
    // 3 task_receipt_manager, 4 claim_receipt_manager
    let owner_badge = commit.new_resource_addresses()[0];
    let royalty_admin_badge = commit.new_resource_addresses()[1];
    let task_receipt_resource = commit.new_resource_addresses()[3];
    let claim_receipt_resource = commit.new_resource_addresses()[4];

    Fixture {
        ledger,
        owner_pk,
        owner_account,
        poster_pk,
        poster_account,
        worker_pk,
        worker_account,
        arbiter_pk,
        arbiter_account,
        escrow,
        owner_badge,
        royalty_admin_badge,
        worker_badge,
        arbiter_badge,
        reward_token,
        task_receipt_resource,
        claim_receipt_resource,
        // Truthful under the flat emulation (pct=0 → floor is always the
        // required bond). Under setup_bond_params it is only the FLOOR — those
        // tests compute the per-task bond themselves via claim_task_with_bond.
        claim_bond: claim_bond_floor,
    }
}

fn owner_proof_manifest(f: &Fixture) -> ManifestBuilder {
    ManifestBuilder::new().lock_fee_from_faucet().call_method(
        f.owner_account,
        "create_proof_of_amount",
        manifest_args!(f.owner_badge, dec!("1")),
    )
}

fn add_token_to_whitelist(f: &mut Fixture, token: ResourceAddress, min_amount: Decimal) {
    let manifest = owner_proof_manifest(f)
        .call_method(
            f.escrow,
            "add_accepted_token",
            manifest_args!(token, min_amount),
        )
        .build();
    f.ledger
        .execute_manifest(
            manifest,
            vec![NonFungibleGlobalId::from_public_key(&f.owner_pk)],
        )
        .expect_commit_success();
}

fn create_task(
    f: &mut Fixture,
    reward_amount: Decimal,
    insurance_amount: Decimal,
    arbiter_fee_pct: Decimal,
) -> TransactionReceipt {
    let total = reward_amount + insurance_amount;
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .withdraw_from_account(f.poster_account, f.reward_token, total)
        .take_from_worktop(f.reward_token, reward_amount, "reward")
        .take_from_worktop(f.reward_token, insurance_amount, "insurance")
        .call_method_with_name_lookup(f.escrow, "create_task", |lookup| {
            (
                f.poster_account,
                lookup.bucket("reward"),
                lookup.bucket("insurance"),
                arbiter_fee_pct,
                WORK_BRIEF,
            )
        })
        .call_method(
            f.poster_account,
            "deposit_batch",
            manifest_args!(ManifestExpression::EntireWorktop),
        )
        .build();
    f.ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&f.poster_pk)],
    )
}

fn claim_task(f: &mut Fixture, task_id: u64) -> TransactionReceipt {
    let bond = f.claim_bond;
    claim_task_with_bond(f, task_id, bond)
}

/// Claim with an EXPLICIT bond amount — the required bond is per-task under
/// proportional sizing (`clamp(pct * reward, floor, cap)`), so tests off the
/// flat emulation compute it themselves. The bond is staked in the task's
/// REWARD token (stage 5a); the worker is funded with it at setup.
fn claim_task_with_bond(f: &mut Fixture, task_id: u64, bond: Decimal) -> TransactionReceipt {
    let mut builder = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .create_proof_from_account_of_non_fungibles(
            f.worker_account,
            f.worker_badge,
            vec![NonFungibleLocalId::integer(1)],
        )
        .pop_from_auth_zone("worker_proof");
    // A zero bond (pct=0/floor=0/cap=0 config) stakes an EMPTY bucket: taking
    // 0 from the worktop mints one, no account withdrawal needed.
    if bond > Decimal::ZERO {
        builder = builder.withdraw_from_account(f.worker_account, f.reward_token, bond);
    }
    let manifest = builder
        .take_from_worktop(f.reward_token, bond, "bond")
        .call_method_with_name_lookup(f.escrow, "claim_task", |lookup| {
            (task_id, f.worker_account, lookup.proof("worker_proof"), lookup.bucket("bond"))
        })
        .call_method(
            f.worker_account,
            "deposit_batch",
            manifest_args!(ManifestExpression::EntireWorktop),
        )
        .build();
    f.ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&f.worker_pk)],
    )
}

fn expire_claim(f: &mut Fixture, task_id: u64) -> TransactionReceipt {
    // Signed by the ARBITER account deliberately: a neutral bystander who is
    // neither poster nor worker. The bounty (DB-4) lands with the CALLER, so a
    // caller distinct from both parties is what lets tests assert "the caller
    // was paid AND the poster was not" without the two roles aliasing.
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .call_method(f.escrow, "expire_claim", manifest_args!(task_id))
        .call_method(
            f.arbiter_account,
            "deposit_batch",
            manifest_args!(ManifestExpression::EntireWorktop),
        )
        .build();
    f.ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&f.arbiter_pk)],
    )
}

fn cancel_task_by_poster_after_claim(
    f: &mut Fixture,
    task_id: u64,
) -> TransactionReceipt {
    let receipt_nf_id = NonFungibleLocalId::integer(task_id);
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .create_proof_from_account_of_non_fungibles(
            f.poster_account,
            f.task_receipt_resource,
            indexset![receipt_nf_id],
        )
        .pop_from_auth_zone("receipt")
        .call_method_with_name_lookup(
            f.escrow,
            "cancel_task_by_poster_after_claim",
            |lookup| (task_id, lookup.proof("receipt")),
        )
        // PULL: the worktop is EMPTY here. There is no bond bucket to route to
        // the worker and no reward/insurance to sweep to the poster — that
        // routing was the vulnerability, and its absence is the fix. Each party
        // now collects via withdraw_*. The deposit_batch is kept deliberately:
        // it proves the worktop is empty rather than assuming it, since a
        // non-empty worktop at end of manifest would abort the transaction.
        .call_method(
            f.poster_account,
            "deposit_batch",
            manifest_args!(ManifestExpression::EntireWorktop),
        )
        .build();
    f.ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&f.poster_pk)],
    )
}

fn submit_task(f: &mut Fixture, task_id: u64, claim_receipt_id: u64) -> TransactionReceipt {
    let receipt_nf_id = NonFungibleLocalId::integer(claim_receipt_id);
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .withdraw_non_fungibles_from_account(
            f.worker_account,
            f.claim_receipt_resource,
            indexset![receipt_nf_id],
        )
        .take_all_from_worktop(f.claim_receipt_resource, "claim_receipt")
        .call_method_with_name_lookup(f.escrow, "submit_task", |lookup| {
            // evidence + the brief being answered (P4-3's on-chain leg).
            (task_id, lookup.bucket("claim_receipt"), Hash([1u8; 32]), WORK_BRIEF)
        })
        .call_method(
            f.worker_account,
            "deposit_batch",
            manifest_args!(ManifestExpression::EntireWorktop),
        )
        .build();
    f.ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&f.worker_pk)],
    )
}

/// Advance to just past `claim_deadline + expire_grace_secs` — the earliest
/// point at which `expire_claim` is callable under D-P3.
///
/// The `+ EXPIRE_GRACE_SECS` is load-bearing, not padding. Before D-P3 these
/// tests advanced past the deadline alone, and every one of them broke when the
/// grace window landed. Naming the wait stops the next edit from quietly
/// dropping it again and reintroducing the late-submit race the window closes.
///
/// It took an `extra_secs` parameter until DB-3. Every non-zero caller was a
/// test that had HEARTBEATED the deadline further out first; with that leg gone
/// all callers passed 0, and a parameter every caller passes 0 to is the exact
/// shape that gets "simplified away" next to the `+ EXPIRE_GRACE_SECS` term it
/// sits beside. Dropped deliberately, not overlooked — a claim deadline is now
/// fixed at claim time, so re-adding it means a new extension mechanism exists.
fn advance_past_expire_grace(ledger: &mut DefaultLedgerSimulator) {
    advance_time_by_secs(
        ledger,
        (HUMAN_DEADLINE_SECS as i64) + (EXPIRE_GRACE_SECS as i64) + 1,
    );
}

/// Advance ledger time forward by `secs` seconds via a single round advance.
fn advance_time_by_secs(ledger: &mut DefaultLedgerSimulator, secs: i64) {
    let current_ms = ledger.get_current_proposer_timestamp_ms();
    let current_round = ledger.get_consensus_manager_state().round.number();
    ledger
        .advance_to_round_at_timestamp(Round::of(current_round + 1), current_ms + secs * 1000)
        .expect_commit_success();
}

fn fetch_task(f: &mut Fixture, task_id: u64) -> TaskInfo {
    let info: Option<TaskInfo> = f
        .ledger
        .call_method(f.escrow, "get_task_info", manifest_args!(task_id))
        .expect_commit_success()
        .output(1);
    info.expect("task missing")
}

fn fetch_balances(f: &mut Fixture, task_id: u64) -> (Decimal, Decimal, Decimal) {
    f.ledger
        .call_method(f.escrow, "get_task_balances", manifest_args!(task_id))
        .expect_commit_success()
        .output(1)
}

// ── PULL: entitlements + withdrawals ─────────────────────────────────────────

/// (worker_entitled, poster_entitled, arbiter_entitled) — settled but not yet
/// collected. Under pull this is where the money IS between settlement and
/// collection, so most assertions that used to read account balances now read
/// here first and the balance second.
/// Present the task receipt as a BUCKET (burn consumes it, unlike every other
/// poster path, which now takes a Proof).
fn burn_task_receipt(f: &mut Fixture, task_id: u64) -> TransactionReceipt {
    let receipt_nf_id = NonFungibleLocalId::integer(task_id);
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .withdraw_non_fungibles_from_account(
            f.poster_account,
            f.task_receipt_resource,
            indexset![receipt_nf_id],
        )
        .take_all_from_worktop(f.task_receipt_resource, "receipt")
        .call_method_with_name_lookup(f.escrow, "burn_task_receipt", |lookup| {
            (lookup.bucket("receipt"),)
        })
        .call_method(
            f.poster_account,
            "deposit_batch",
            manifest_args!(ManifestExpression::EntireWorktop),
        )
        .build();
    f.ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&f.poster_pk)],
    )
}

fn fetch_bond_entitlements(f: &mut Fixture, task_id: u64) -> (Decimal, Decimal) {
    f.ledger
        .call_method(f.escrow, "get_bond_entitlements", manifest_args!(task_id))
        .expect_commit_success()
        .output(1)
}

/// `(reward_lane_held, bond_lane_held)` — what the settlement vaults actually
/// hold. This is the DENOMINATOR: asserting entitlements alone proves the
/// bookkeeping is self-consistent, not that it is backed by funds.
fn fetch_settlement_balances(f: &mut Fixture, task_id: u64) -> (Decimal, Decimal) {
    f.ledger
        .call_method(f.escrow, "get_settlement_balances", manifest_args!(task_id))
        .expect_commit_success()
        .output(1)
}

fn fetch_entitlements(f: &mut Fixture, task_id: u64) -> (Decimal, Decimal) {
    f.ledger
        .call_method(f.escrow, "get_entitlements", manifest_args!(task_id))
        .expect_commit_success()
        .output(1)
}

/// Worker collects. Authenticated by the badge they claimed with.
fn withdraw_worker(f: &mut Fixture, task_id: u64) -> TransactionReceipt {
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .create_proof_from_account_of_non_fungibles(
            f.worker_account,
            f.worker_badge,
            vec![NonFungibleLocalId::integer(1)],
        )
        .pop_from_auth_zone("worker_proof")
        .call_method_with_name_lookup(f.escrow, "withdraw_worker", |lookup| {
            (task_id, lookup.proof("worker_proof"))
        })
        .call_method(
            f.worker_account,
            "deposit_batch",
            manifest_args!(ManifestExpression::EntireWorktop),
        )
        .build();
    f.ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&f.worker_pk)],
    )
}

/// Poster collects. Authenticated by the task receipt, which under pull is a
/// persistent entitlement key rather than a one-shot token.
fn withdraw_poster(f: &mut Fixture, task_id: u64) -> TransactionReceipt {
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .create_proof_from_account_of_non_fungibles(
            f.poster_account,
            f.task_receipt_resource,
            indexset![NonFungibleLocalId::integer(task_id)],
        )
        .pop_from_auth_zone("receipt")
        .call_method_with_name_lookup(f.escrow, "withdraw_poster", |lookup| {
            (task_id, lookup.proof("receipt"))
        })
        .call_method(
            f.poster_account,
            "deposit_batch",
            manifest_args!(ManifestExpression::EntireWorktop),
        )
        .build();
    f.ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&f.poster_pk)],
    )
}

// ── PR 2.1 + 2.2 scaffold / lifecycle tests (still applicable) ───────────────

#[test]
fn test_instantiate_creates_component_and_owner_badge() {
    let mut f = setup();
    assert_eq!(
        f.ledger.get_component_balance(f.owner_account, f.owner_badge),
        dec!("1")
    );
}

#[test]
fn test_add_accepted_token_succeeds_and_listed() {
    let mut f = setup();
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));
    let tokens: Vec<(ResourceAddress, AcceptedTokenConfig)> = f
        .ledger
        .call_method(f.escrow, "get_accepted_tokens", manifest_args!())
        .expect_commit_success()
        .output(1);
    assert_eq!(tokens.len(), 1);
    assert_eq!(tokens[0].0, f.reward_token);
    assert_eq!(tokens[0].1.min_amount, dec!("10"));
    assert!(!tokens[0].1.frozen);
}

#[test]
fn test_freeze_unfreeze_token() {
    let mut f = setup();
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));

    let freeze = owner_proof_manifest(&f)
        .call_method(f.escrow, "freeze_token", manifest_args!(f.reward_token))
        .build();
    f.ledger
        .execute_manifest(freeze, vec![NonFungibleGlobalId::from_public_key(&f.owner_pk)])
        .expect_commit_success();

    let tokens: Vec<(ResourceAddress, AcceptedTokenConfig)> = f
        .ledger
        .call_method(f.escrow, "get_accepted_tokens", manifest_args!())
        .expect_commit_success()
        .output(1);
    assert!(tokens[0].1.frozen);

    let unfreeze = owner_proof_manifest(&f)
        .call_method(f.escrow, "unfreeze_token", manifest_args!(f.reward_token))
        .build();
    f.ledger
        .execute_manifest(unfreeze, vec![NonFungibleGlobalId::from_public_key(&f.owner_pk)])
        .expect_commit_success();
}

#[test]
fn test_instantiate_rejects_invalid_max_arbiter_fee_pct() {
    let mut ledger = LedgerSimulatorBuilder::new().build();
    let (owner_pk, _, owner_account) = ledger.new_allocated_account();
    let package_address = ledger.compile_and_publish(this_package!());
    let worker_badge = ledger.create_fungible_resource(dec!("1"), DIVISIBILITY_NONE, owner_account);
    let arbiter_badge = ledger.create_fungible_resource(dec!("1"), DIVISIBILITY_NONE, owner_account);

    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .call_function(
            package_address,
            "Escrow",
            "instantiate",
            manifest_args!(
                worker_badge,
                arbiter_badge,
                None::<ResourceAddress>,
                dec!("0.75"),
                604800u64,
                86400u64,
                1209600u64,
                EXPIRE_GRACE_SECS,
                AutoResolveDefault::FavorDisputeRaiser,
                dec!("0.05"),
                dec!("0.1"),
                dec!("0.5"),
                dec!("5"),
                dec!("0.1"),
                REVIEW_WINDOW_SECS,
            ),
        )
        .build();
    let receipt = ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&owner_pk)],
    );
    // ⚠️ Pinned to the assert's own message, not a bare is_commit_failure().
    // This test hand-rolls its arg list instead of going through `setup_full`,
    // so it is the one place a stale arity survives — and a stale arity fails
    // the tx on SBOR decode BEFORE `max_arbiter_fee_pct` is ever looked at. The
    // weak form passed either way: it reported green while testing nothing.
    // DB-3's 13→11 change is exactly the edit that would have armed that —
    // and stage 5a's 11→14 change armed it again, which is why the four bond
    // args above are deliberately VALID: only the fee pct may be the reason.
    receipt.expect_commit_failure_containing_error("max_arbiter_fee_pct must be in [0, 0.5]");
}

/// The one cross-FIELD validation in `instantiate`: `cap >= floor`. Ledger-level
/// because it is the invariant that justifies `set_claim_bond_params` moving
/// all three values in one call — a transient cap<floor state must be
/// unreachable from birth too, not just from the setter.
#[test]
fn test_instantiate_rejects_cap_below_floor() {
    let mut ledger = LedgerSimulatorBuilder::new().build();
    let (owner_pk, _, owner_account) = ledger.new_allocated_account();
    let package_address = ledger.compile_and_publish(this_package!());
    let worker_badge = ledger.create_fungible_resource(dec!("1"), DIVISIBILITY_NONE, owner_account);
    let arbiter_badge = ledger.create_fungible_resource(dec!("1"), DIVISIBILITY_NONE, owner_account);

    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .call_function(
            package_address,
            "Escrow",
            "instantiate",
            manifest_args!(
                worker_badge,
                arbiter_badge,
                None::<ResourceAddress>,
                dec!("0.1"),
                604800u64,
                86400u64,
                1209600u64,
                EXPIRE_GRACE_SECS,
                AutoResolveDefault::SplitEvenly,
                dec!("0.05"),
                dec!("0.1"),
                dec!("5"),   // floor 5 …
                dec!("0.5"), // … cap 0.5 — inverted on purpose
                dec!("0.1"),
                REVIEW_WINDOW_SECS,
            ),
        )
        .build();
    let receipt = ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&owner_pk)],
    );
    receipt.expect_commit_failure_containing_error("claim_bond_cap must be >= claim_bond_floor");
}

#[test]
fn test_create_task_happy_path() {
    let mut f = setup();
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));

    create_task(&mut f, dec!("100"), dec!("10"), dec!("0.1")).expect_commit_success();

    let info = fetch_task(&mut f, 1);
    assert_eq!(info.reward_amount, dec!("100"));
    assert_eq!(info.insurance_amount, dec!("10"));
    assert_eq!(info.state, TaskState::Open);
    assert_eq!(info.arbiter_fee_pct, dec!("0.1"));
    assert!(info.current_claim_receipt_id.is_none());

    let balances = fetch_balances(&mut f, 1);
    assert_eq!(balances.0, dec!("100"));
    assert_eq!(balances.1, dec!("10"));
    assert_eq!(balances.2, dec!("0"), "no claim bond yet");
}

#[test]
fn test_create_task_rejects_unknown_token() {
    let mut f = setup();
    let receipt = create_task(&mut f, dec!("100"), dec!("10"), dec!("0.1"));
    assert!(receipt.is_commit_failure(), "must reject unknown token");
}

#[test]
fn test_create_task_rejects_frozen_token() {
    let mut f = setup();
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));

    let freeze = owner_proof_manifest(&f)
        .call_method(f.escrow, "freeze_token", manifest_args!(f.reward_token))
        .build();
    f.ledger
        .execute_manifest(freeze, vec![NonFungibleGlobalId::from_public_key(&f.owner_pk)])
        .expect_commit_success();

    let receipt = create_task(&mut f, dec!("100"), dec!("10"), dec!("0.1"));
    assert!(receipt.is_commit_failure(), "must reject frozen token");
}

#[test]
fn test_create_task_rejects_too_low_insurance() {
    let mut f = setup();
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));
    let receipt = create_task(&mut f, dec!("100"), dec!("1"), dec!("0.1"));
    assert!(receipt.is_commit_failure(), "must reject too-low insurance");
}

#[test]
fn test_create_task_rejects_too_high_arbiter_fee() {
    let mut f = setup();
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));
    let receipt = create_task(&mut f, dec!("100"), dec!("10"), dec!("0.75"));
    assert!(receipt.is_commit_failure(), "must reject too-high arbiter_fee_pct");
}

#[test]
fn test_create_task_rejects_reward_below_min_amount() {
    let mut f = setup();
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("50"));
    let receipt = create_task(&mut f, dec!("10"), dec!("1"), dec!("0.1"));
    assert!(receipt.is_commit_failure(), "must reject reward below per-token min");
}

// ── PR 2.3 multi-actor claim_task flow (now testable) ───────────────────────

#[test]
fn test_claim_task_happy_path() {
    let mut f = setup();
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));
    create_task(&mut f, dec!("100"), dec!("10"), dec!("0.1")).expect_commit_success();

    claim_task(&mut f, 1).expect_commit_success();

    let info = fetch_task(&mut f, 1);
    assert_eq!(info.state, TaskState::Claimed);
    assert!(info.claim_deadline.is_some());
    assert!(!info.claimer_is_agent);
    assert_eq!(info.current_claim_receipt_id, Some(1));

    let balances = fetch_balances(&mut f, 1);
    assert_eq!(balances.2, dec!("1"), "claim_bond posted");

    // Worker holds claim_receipt #1
    assert_eq!(
        f.ledger
            .get_component_balance(f.worker_account, f.claim_receipt_resource),
        dec!("1")
    );
}

#[test]
fn test_self_claim_rejects() {
    // Finding 8: a badge holder declaring the POSTER's account as the payout
    // target is the one-account self-dealing loop — must reject at claim.
    let mut f = setup();
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));
    create_task(&mut f, dec!("100"), dec!("10"), dec!("0.1")).expect_commit_success();

    let bond = f.claim_bond;
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .create_proof_from_account_of_non_fungibles(
            f.worker_account,
            f.worker_badge,
            vec![NonFungibleLocalId::integer(1)],
        )
        .pop_from_auth_zone("worker_proof")
        .withdraw_from_account(f.worker_account, f.reward_token, bond)
        .take_from_worktop(f.reward_token, bond, "bond")
        .call_method_with_name_lookup(f.escrow, "claim_task", |lookup| {
            // worker payout account == poster account → self-claim
            (1u64, f.poster_account, lookup.proof("worker_proof"), lookup.bucket("bond"))
        })
        .call_method(
            f.worker_account,
            "deposit_batch",
            manifest_args!(ManifestExpression::EntireWorktop),
        )
        .build();
    let receipt = f.ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&f.worker_pk)],
    );
    // Five asserts precede the self-claim gate (badge resource, bond resource,
    // bond amount, task exists, state==Open). A bare failure check cannot tell
    // this test's subject apart from any of them — and this is the assert a live
    // mainnet probe will be cited as proving.
    receipt.expect_commit_failure_containing_error("self-claim not allowed");

    // Task stays Open and is claimable by a non-poster account afterwards.
    let info = fetch_task(&mut f, 1);
    assert_eq!(info.state, TaskState::Open);
    claim_task(&mut f, 1).expect_commit_success();
}

// DB-3 (sitting 2026-08-06) deleted the three PR-2.3 heartbeat tests that stood
// here — extends-and-deducts, past-deadline-rejects, wrong-task-id-rejects. They
// tested a method that no longer exists; keeping shells of them would be
// coverage theatre. What they proved that is NOT heartbeat-specific is proved
// elsewhere and stayed: the claim_deadline itself is pinned by the expire tests
// below, and `current_claim_receipt_id` binding — the check heartbeat shared
// with submit — by `test_submit_with_orphan_receipt_rejects` and
// `test_submit_with_orphan_after_cancel_after_claim_rejects`.
// The method's absence is pinned mechanically by
// `test_instantiate_signature_matches_the_signed_sheet` at the bottom of this
// file, which fails if the two heartbeat args come back.

// ── PR 2.3 expire_claim tests ───────────────────────────────────────────────

#[test]
fn test_expire_claim_after_deadline_succeeds() {
    let mut f = setup();
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));
    create_task(&mut f, dec!("100"), dec!("10"), dec!("0.1")).expect_commit_success();
    claim_task(&mut f, 1).expect_commit_success();

    let balances_before = fetch_balances(&mut f, 1);
    let forfeit_amount = balances_before.2;
    assert_eq!(forfeit_amount, dec!("1"), "bond (reward-token units) staked pre-expire");

    advance_past_expire_grace(&mut f.ledger);
    expire_claim(&mut f, 1).expect_commit_success();

    let info_after = fetch_task(&mut f, 1);
    assert_eq!(info_after.state, TaskState::Open, "task back to Open");
    assert!(info_after.claim_deadline.is_none());
    assert!(info_after.claimer_badge_id.is_none());
    assert!(info_after.current_claim_receipt_id.is_none());

    let balances_after = fetch_balances(&mut f, 1);
    assert_eq!(balances_after.0, dec!("100"), "reward stays");
    assert_eq!(balances_after.1, dec!("10"), "insurance stays");
    assert_eq!(balances_after.2, dec!("0"), "bond forfeited");

    // DB-4: the forfeited bond must NOT become a poster entitlement — that
    // shape paid a poster to author unsatisfiable briefs and farm the bond of
    // every claimer. THE anti-farming assert; everything else in this test
    // would stay green if the credit came back.
    assert_eq!(
        fetch_bond_entitlements(&mut f, 1),
        (dec!("0"), dec!("0")),
        "an expired bond credits NEITHER party's entitlement"
    );
}

/// DB-4 (sitting 2026-08-06): the forfeited bond SPLITS — a caller bounty,
/// remainder to the operator vault. Since stage 5 the bounty is PROPORTIONAL
/// (`expire_bounty_pct`, operator ruling 2026-08-29 — the old flat 1 XRD was
/// ~a tenth of a cent, and actively wrong once the bond is a stablecoin). At
/// the live-sized bond of 10 and the 0.1 fixture pct, BOTH legs are nonzero —
/// 1 to the caller, 9 to the house — and each is asserted on the balance of
/// the party that received it, in the REWARD token the bond now lives in.
#[test]
fn test_expire_bounty_splits_caller_and_house() {
    let mut f = setup_with_bond("10");
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));
    create_task(&mut f, dec!("100"), dec!("10"), dec!("0.1")).expect_commit_success();
    claim_task(&mut f, 1).expect_commit_success();

    let caller_before = f.ledger.get_component_balance(f.arbiter_account, f.reward_token);
    let house_before = fetch_forfeited(&mut f);

    advance_past_expire_grace(&mut f.ledger);
    expire_claim(&mut f, 1).expect_commit_success();

    // The caller (a neutral bystander — see the expire_claim helper) earns
    // exactly 10% of the forfeited 10. Balance-asserted on the recipient, and
    // in the reward token — an XRD delta here would read 0 and prove nothing.
    assert_eq!(
        f.ledger.get_component_balance(f.arbiter_account, f.reward_token) - caller_before,
        dec!("1"),
        "the expire caller earns expire_bounty_pct of the bond"
    );
    // The house takes the remainder…
    assert_eq!(
        fetch_forfeited(&mut f) - house_before,
        dec!("9"),
        "the operator vault takes bond minus bounty"
    );
    // …and the poster's entitlement takes NOTHING (the anti-farming property
    // at the size where farming would actually pay).
    assert_eq!(
        fetch_bond_entitlements(&mut f, 1),
        (dec!("0"), dec!("0")),
        "no party is entitled to a forfeited bond"
    );
}

#[test]
fn test_expire_claim_before_deadline_rejects() {
    let mut f = setup();
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));
    create_task(&mut f, dec!("100"), dec!("10"), dec!("0.1")).expect_commit_success();
    claim_task(&mut f, 1).expect_commit_success();

    let receipt = expire_claim(&mut f, 1);
    assert!(
        receipt.is_commit_failure(),
        "expire before deadline must reject"
    );
}

/// D-P3 — the grace window, which is the whole late-submit fix (L3).
///
/// Between `claim_deadline` and `claim_deadline + expire_grace_secs` BOTH a late
/// `submit_task` and an `expire_claim` used to be valid, and it was first-to-commit:
/// the worker got their bond back, or any bystander forfeited it for the price of
/// gas, with no badge or stake required. `expire_claim` is PUBLIC, so the bystander
/// needed nothing at all.
///
/// This asserts the window exists and belongs to the worker: mid-grace `expire_claim`
/// REJECTS while the worker's `submit_task` still SUCCEEDS. The preceding test only
/// covers before-the-deadline, which was never the racy interval — it would stay
/// green with the grace window deleted, so it is not a D-P3 proof.
#[test]
fn test_expire_within_grace_window_rejects_but_worker_can_still_submit() {
    let mut f = setup();
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));
    create_task(&mut f, dec!("100"), dec!("10"), dec!("0.1")).expect_commit_success();
    claim_task(&mut f, 1).expect_commit_success();

    // Past the deadline, but strictly INSIDE the grace window.
    advance_time_by_secs(
        &mut f.ledger,
        (HUMAN_DEADLINE_SECS as i64) + ((EXPIRE_GRACE_SECS as i64) / 2),
    );

    let receipt = expire_claim(&mut f, 1);
    assert!(
        receipt.is_commit_failure(),
        "D-P3: expire_claim inside the grace window must reject — the window belongs to the worker"
    );

    // The other half of the property: the worker is not merely protected from the
    // bystander, they can actually still deliver. A window that blocked both would
    // pass the assertion above and be useless.
    submit_task(&mut f, 1, 1).expect_commit_success();
    assert_eq!(
        fetch_task(&mut f, 1).state,
        TaskState::Submitted,
        "the late submit inside the grace window is exactly what the window is for"
    );
}

#[test]
fn test_expire_then_reclaim_succeeds_with_fresh_receipt_id() {
    let mut f = setup();
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));
    create_task(&mut f, dec!("100"), dec!("10"), dec!("0.1")).expect_commit_success();
    claim_task(&mut f, 1).expect_commit_success();
    advance_past_expire_grace(&mut f.ledger);
    expire_claim(&mut f, 1).expect_commit_success();

    // Re-claim by same worker: mints a new claim_receipt with id=2
    claim_task(&mut f, 1).expect_commit_success();
    let info = fetch_task(&mut f, 1);
    assert_eq!(info.state, TaskState::Claimed);
    assert_eq!(
        info.current_claim_receipt_id,
        Some(2),
        "second claim must use fresh claim_receipt id"
    );
    let balances = fetch_balances(&mut f, 1);
    assert_eq!(balances.2, dec!("1"), "bond restored on re-claim");

    // Worker now has both receipts (orphan #1 + active #2)
    assert_eq!(
        f.ledger
            .get_component_balance(f.worker_account, f.claim_receipt_resource),
        dec!("2"),
        "worker holds orphan + active claim_receipt"
    );
}

#[test]
fn test_submit_with_orphan_receipt_rejects() {
    let mut f = setup();
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));
    create_task(&mut f, dec!("100"), dec!("10"), dec!("0.1")).expect_commit_success();
    claim_task(&mut f, 1).expect_commit_success();
    advance_past_expire_grace(&mut f.ledger);
    expire_claim(&mut f, 1).expect_commit_success();
    claim_task(&mut f, 1).expect_commit_success();

    // Orphan is receipt id 1; active is id 2. Try to submit with orphan.
    let receipt = submit_task(&mut f, 1, 1);
    assert!(
        receipt.is_commit_failure(),
        "submit with orphan (stale) receipt must reject"
    );
}

/// A LIVE receipt for one task cannot act on a DIFFERENT task.
///
/// This is the cross-task half of the `current_claim_receipt_id` guard, and it
/// is here because DB-3 deleted the only test that claimed to cover it —
/// `test_heartbeat_with_wrong_task_id_rejects`. That test never actually
/// reached the guard: it left task 2 **Open**, so `task must be Claimed` fired
/// first, and its bare `is_commit_failure()` could not tell the two apart. It
/// had been passing for the wrong reason since PR 2.3.
///
/// The strong form claims BOTH tasks so task 2 is genuinely Claimed, then
/// submits against it with task 1's receipt, and pins the guard's own message.
/// The stale-receipt tests above cover the orphan case (an expired or cancelled
/// receipt on its OWN task); neither covers this one.
#[test]
fn test_submit_with_another_tasks_live_receipt_rejects() {
    let mut f = setup();
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));
    create_task(&mut f, dec!("100"), dec!("10"), dec!("0.1")).expect_commit_success();
    create_task(&mut f, dec!("100"), dec!("10"), dec!("0.1")).expect_commit_success();
    claim_task(&mut f, 1).expect_commit_success();
    claim_task(&mut f, 2).expect_commit_success();

    // Both tasks are Claimed, so `task must be Claimed` cannot mask the result.
    assert_eq!(fetch_task(&mut f, 2).state, TaskState::Claimed);
    assert_eq!(fetch_task(&mut f, 2).current_claim_receipt_id, Some(2));

    // Receipt 1 belongs to task 1. Present it against task 2.
    submit_task(&mut f, 2, 1)
        .expect_commit_failure_containing_error("claim_receipt is not the active one for this task");
}

#[test]
fn test_expire_when_task_open_rejects() {
    let mut f = setup();
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));
    create_task(&mut f, dec!("100"), dec!("10"), dec!("0.1")).expect_commit_success();

    let receipt = expire_claim(&mut f, 1);
    assert!(
        receipt.is_commit_failure(),
        "expire on Open task must reject"
    );
}

// ── PR 2.3 cancel_task_by_poster_after_claim tests ──────────────────────────

#[test]
fn test_cancel_after_claim_returns_bond_to_worker_and_reward_to_poster() {
    let mut f = setup();
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));
    create_task(&mut f, dec!("100"), dec!("10"), dec!("0.1")).expect_commit_success();
    claim_task(&mut f, 1).expect_commit_success();

    let worker_before = f.ledger.get_component_balance(f.worker_account, f.reward_token);
    let poster_reward_before = f.ledger.get_component_balance(f.poster_account, f.reward_token);

    cancel_task_by_poster_after_claim(&mut f, 1).expect_commit_success();

    // PULL: settlement moves NOBODY's money. It credits, and each party then
    // collects. This test previously asserted the balances changed inside the
    // settlement transaction — which was true under push, and was the bug: the
    // destination came from the poster's manifest, so the test was asserting a
    // destination its own helper supplied rather than one the blueprint enforced.
    assert_eq!(
        f.ledger.get_component_balance(f.worker_account, f.reward_token) - worker_before,
        dec!("0"),
        "settlement pays nobody — the worker is credited, then collects"
    );
    assert_eq!(
        f.ledger.get_component_balance(f.poster_account, f.reward_token) - poster_reward_before,
        dec!("0"),
        "settlement pays nobody — the poster is credited, then collects"
    );

    let info = fetch_task(&mut f, 1);
    assert_eq!(info.state, TaskState::Refunded);
    assert!(info.current_claim_receipt_id.is_none());
    let balances = fetch_balances(&mut f, 1);
    assert_eq!(
        balances,
        (dec!("0"), dec!("0"), dec!("0")),
        "the three ESCROW vaults are drained into the settlement lanes"
    );

    // This is the settlement that credits BOTH lanes in one transaction —
    // reward + insurance to the poster, the bond to the worker. It is the one
    // that failed with InvalidDropAccess when both shared a single vault (the
    // lanes were different RESOURCES then; the vault split that fixed it is
    // what still keeps them apart now that stage 5a made them one resource).
    assert_eq!(fetch_entitlements(&mut f, 1), (dec!("0"), dec!("110")));
    assert_eq!(fetch_bond_entitlements(&mut f, 1), (dec!("1"), dec!("0")));
    assert_eq!(fetch_settlement_balances(&mut f, 1), (dec!("110"), dec!("1")));

    // Now the destinations the blueprint DOES enforce.
    withdraw_worker(&mut f, 1).expect_commit_success();
    withdraw_poster(&mut f, 1).expect_commit_success();
    assert_eq!(
        f.ledger.get_component_balance(f.worker_account, f.reward_token) - worker_before,
        dec!("1"),
        "worker collects exactly the claim_bond"
    );
    assert_eq!(
        f.ledger.get_component_balance(f.poster_account, f.reward_token) - poster_reward_before,
        dec!("110"),
        "poster collects reward + insurance"
    );
    assert_eq!(fetch_settlement_balances(&mut f, 1), (dec!("0"), dec!("0")));
}

/// The poster's withdrawal on this path has ONE empty lane (no bond is owed to
/// them) and the worker's has the other empty (no reward). Both must succeed.
///
/// This is the case a per-lane `amount > 0` assert would have fund-locked, and
/// it is the reason the check lives on the combined total instead.
#[test]
fn test_withdraw_succeeds_with_exactly_one_empty_lane() {
    let mut f = setup();
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));
    create_task(&mut f, dec!("100"), dec!("10"), dec!("0.1")).expect_commit_success();
    claim_task(&mut f, 1).expect_commit_success();
    cancel_task_by_poster_after_claim(&mut f, 1).expect_commit_success();

    // Worker: reward lane empty, bond lane 1.
    assert_eq!(fetch_entitlements(&mut f, 1).0, dec!("0"));
    assert_eq!(fetch_bond_entitlements(&mut f, 1).0, dec!("1"));
    withdraw_worker(&mut f, 1).expect_commit_success();

    // Poster: reward lane 110, bond lane empty.
    assert_eq!(fetch_entitlements(&mut f, 1).1, dec!("110"));
    assert_eq!(fetch_bond_entitlements(&mut f, 1).1, dec!("0"));
    withdraw_poster(&mut f, 1).expect_commit_success();

    // And with BOTH lanes now empty, either party trying again must fail —
    // that is the combined assert doing its job rather than a vault error.
    withdraw_worker(&mut f, 1).expect_commit_failure();
    withdraw_poster(&mut f, 1).expect_commit_failure();
}

#[test]
fn test_cancel_after_claim_rejects_when_open() {
    let mut f = setup();
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));
    create_task(&mut f, dec!("100"), dec!("10"), dec!("0.1")).expect_commit_success();
    // No claim — task is Open, not Claimed
    let receipt = cancel_task_by_poster_after_claim(&mut f, 1);
    assert!(
        receipt.is_commit_failure(),
        "cancel_after_claim on Open task must reject"
    );
}

// ── PR 2.3 forfeited-bond accounting ─────────────────────────────────────────

/// ⚠️ This test ran on the fixture's 1 XRD bond and reached the house vault by
/// HEARTBEATING the bond down to 0.9 first. DB-3 deleted that leg; stage 5
/// then replaced the flat `min(1 XRD, bond)` bounty with a proportional
/// `expire_bounty_pct` in the reward token. It runs at the LIVE bond (10) so
/// the house share is a real 9, asserted exactly before the withdrawal —
/// forfeits are keyed by RESOURCE now (`withdraw_forfeited_bonds(resource)`),
/// because a multi-token component forfeits multi-token bonds.
#[test]
fn test_owner_withdraws_forfeited_bonds_accumulated() {
    let mut f = setup_with_bond("10");
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));
    create_task(&mut f, dec!("100"), dec!("10"), dec!("0.1")).expect_commit_success();
    claim_task(&mut f, 1).expect_commit_success();

    // DB-4 (sitting 2026-08-06, replacing D-P4's poster-credit): on expire the
    // bond pays the CALLER a proportional bounty and the house takes the rest.
    // At the live bond both legs are non-zero — 1 to the caller, 9 to the
    // house — and the poster (D-P4's beneficiary, and the farming vector) gets
    // nothing at all.
    advance_past_expire_grace(&mut f.ledger);
    let caller_before = f.ledger.get_component_balance(f.arbiter_account, f.reward_token);
    expire_claim(&mut f, 1).expect_commit_success();

    assert_eq!(
        fetch_forfeited(&mut f),
        dec!("9"),
        "the house holds the bond LESS the caller bounty — and after DB-3 removed \
         the heartbeat fee, an expired bond is the only thing that ever lands here"
    );
    assert_eq!(
        f.ledger.get_component_balance(f.arbiter_account, f.reward_token) - caller_before,
        dec!("1"),
        "the expire caller is paid the proportional bounty, not the remainder"
    );
    assert_eq!(
        fetch_bond_entitlements(&mut f, 1),
        (dec!("0"), dec!("0")),
        "DB-4: the poster is never credited a forfeited bond"
    );

    let owner_before = f.ledger.get_component_balance(f.owner_account, f.reward_token);

    let manifest = owner_proof_manifest(&f)
        .call_method(f.escrow, "withdraw_forfeited_bonds", manifest_args!(f.reward_token))
        .call_method(
            f.owner_account,
            "deposit_batch",
            manifest_args!(ManifestExpression::EntireWorktop),
        )
        .build();
    f.ledger
        .execute_manifest(
            manifest,
            vec![NonFungibleGlobalId::from_public_key(&f.owner_pk)],
        )
        .expect_commit_success();

    // EXACT now, no longer monotonic: the tx fee is XRD, the payout is the
    // reward token, so the fee schedule can no longer blur this delta. The
    // monotonic form was the weaker assert forced by a same-resource fee.
    assert_eq!(
        f.ledger.get_component_balance(f.owner_account, f.reward_token) - owner_before,
        dec!("9"),
        "the owner receives exactly the house share"
    );
    assert_eq!(
        fetch_forfeited(&mut f),
        Decimal::ZERO,
        "withdraw_forfeited_bonds must drain the vault, not skim it"
    );
}

// ── PR 2.4 dispute lifecycle helpers ────────────────────────────────────────

/// Helper: create task + claim + submit. Task ends in Submitted state ready
/// for dispute. First task always has id=1, first claim_receipt always id=1
/// (fresh fixture per test).
fn full_submit(f: &mut Fixture, reward: Decimal, insurance: Decimal, fee_pct: Decimal) {
    create_task(f, reward, insurance, fee_pct).expect_commit_success();
    claim_task(f, 1).expect_commit_success();
    submit_task(f, 1, 1).expect_commit_success();
}

fn raise_dispute_as_poster(
    f: &mut Fixture,
    task_id: u64,
    evidence_hash: Option<Hash>,
) -> TransactionReceipt {
    let receipt_nf_id = NonFungibleLocalId::integer(task_id);
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .create_proof_from_account_of_non_fungibles(
            f.poster_account,
            f.task_receipt_resource,
            vec![receipt_nf_id],
        )
        .pop_from_auth_zone("task_proof")
        .call_method_with_name_lookup(f.escrow, "raise_dispute", |lookup| {
            (task_id, lookup.proof("task_proof"), evidence_hash)
        })
        .build();
    f.ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&f.poster_pk)],
    )
}

fn raise_dispute_as_worker(
    f: &mut Fixture,
    task_id: u64,
    evidence_hash: Option<Hash>,
) -> TransactionReceipt {
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .create_proof_from_account_of_non_fungibles(
            f.worker_account,
            f.worker_badge,
            vec![NonFungibleLocalId::integer(1)],
        )
        .pop_from_auth_zone("worker_proof")
        .call_method_with_name_lookup(f.escrow, "raise_dispute", |lookup| {
            (task_id, lookup.proof("worker_proof"), evidence_hash)
        })
        .build();
    f.ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&f.worker_pk)],
    )
}

/// `resolve_dispute` takes a PROOF of the badge and returns ONLY the fee. The
/// worker's and poster's shares are CREDITED, not handed to the arbiter —
/// which is the point, since the arbiter is the one party with no claim on
/// them.
///
/// ⚠️ PROOF, NOT BUCKET — and the fixture badge is NON-TRANSFERABLE so the
/// bucket form CANNOT come back quietly. The method took a Bucket until the
/// Wave B ceremony prep caught that the real badge (withdrawer DenyAll,
/// forever, per sheet row 2) can never be withdrawn to produce one: the
/// bucket-form method was uncallable on the component it ships on, and this
/// suite stayed green only because the old fixture minted a transferable
/// badge. The withdraw-based helper would now fail on the fixture roles
/// before ever reaching the method — which is exactly the regression tripwire
/// this comment is standing on.
///
/// Everything left on the worktop is the arbiter's fee, so one `deposit_batch`
/// covers it and doubles as proof the worktop holds nothing else — a non-empty
/// worktop aborts the transaction.
fn resolve_dispute_helper(
    f: &mut Fixture,
    task_id: u64,
    ruling: DisputeRuling,
) -> TransactionReceipt {
    let arbiter_nf_id = NonFungibleLocalId::integer(1);
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .create_proof_from_account_of_non_fungibles(
            f.arbiter_account,
            f.arbiter_badge,
            indexset![arbiter_nf_id],
        )
        .pop_from_auth_zone("arbiter_proof")
        .call_method_with_name_lookup(f.escrow, "resolve_dispute", |lookup| {
            (task_id, lookup.proof("arbiter_proof"), ruling)
        })
        .call_method(
            f.arbiter_account,
            "deposit_batch",
            manifest_args!(ManifestExpression::EntireWorktop),
        )
        .build();
    f.ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&f.arbiter_pk)],
    )
}

/// PULL: `auto_resolve_dispute` returns NOTHING, and that is the whole fix for
/// the anonymous drain. It stays `PUBLIC` — it must, or either party could stall
/// the timeout forever — but a stranger calling it now performs the accounting
/// and receives nothing at all.
///
/// The old helper lifted both counterparties' buckets off the worktop. That was
/// the exploit written as a test helper: `lib.rs` handed `(worker_bucket,
/// poster_bucket)` to whoever called with a task id.
///
/// Signed by the POSTER here only because someone must sign; the method takes no
/// credential. `deposit_batch` is kept deliberately — it proves the worktop is
/// empty rather than assuming it.
fn auto_resolve_dispute(f: &mut Fixture, task_id: u64) -> TransactionReceipt {
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .call_method(f.escrow, "auto_resolve_dispute", manifest_args!(task_id))
        .call_method(
            f.poster_account,
            "deposit_batch",
            manifest_args!(ManifestExpression::EntireWorktop),
        )
        .build();
    f.ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&f.poster_pk)],
    )
}

// ── PR 2.4 raise_dispute tests ──────────────────────────────────────────────

#[test]
fn test_raise_dispute_by_poster_succeeds() {
    let mut f = setup();
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));
    full_submit(&mut f, dec!("100"), dec!("10"), dec!("0.1"));

    raise_dispute_as_poster(&mut f, 1, None).expect_commit_success();

    let info = fetch_task(&mut f, 1);
    assert_eq!(info.state, TaskState::Disputed);
    assert!(info.disputed_at.is_some());
    assert_eq!(info.dispute_raised_by, Some(DisputeParty::Poster));
}

#[test]
fn test_raise_dispute_by_worker_succeeds() {
    let mut f = setup();
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));
    full_submit(&mut f, dec!("100"), dec!("10"), dec!("0.1"));

    raise_dispute_as_worker(&mut f, 1, Some(Hash([0xAB; 32]))).expect_commit_success();

    let info = fetch_task(&mut f, 1);
    assert_eq!(info.state, TaskState::Disputed);
    assert_eq!(info.dispute_raised_by, Some(DisputeParty::Worker));
    assert_eq!(info.dispute_evidence_hash, Some(Hash([0xAB; 32])));
}

#[test]
fn test_raise_dispute_when_not_submitted_rejects() {
    let mut f = setup();
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));
    create_task(&mut f, dec!("100"), dec!("10"), dec!("0.1")).expect_commit_success();
    claim_task(&mut f, 1).expect_commit_success();
    // Task is Claimed, not Submitted

    let receipt = raise_dispute_as_poster(&mut f, 1, None);
    assert!(receipt.is_commit_failure(), "raise on Claimed must reject");
}

// ── PR 2.4 resolve_dispute tests ────────────────────────────────────────────

#[test]
fn test_resolve_dispute_pay_worker() {
    let mut f = setup();
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));
    full_submit(&mut f, dec!("100"), dec!("10"), dec!("0.1"));
    raise_dispute_as_poster(&mut f, 1, None).expect_commit_success();

    let worker_before = f.ledger.get_component_balance(f.worker_account, f.reward_token);
    let poster_before = f.ledger.get_component_balance(f.poster_account, f.reward_token);
    let arbiter_before = f.ledger.get_component_balance(f.arbiter_account, f.reward_token);

    // arbiter_fee = 0.1 * 10 = 1. worker = 100 + 9 = 109. poster = 0.
    resolve_dispute_helper(&mut f, 1, DisputeRuling::PayWorker).expect_commit_success();

    // The ARBITER is still paid inline — caller-is-payee, they just proved
    // custody of the supply-1 badge. Everyone else is credited.
    assert_eq!(
        f.ledger.get_component_balance(f.arbiter_account, f.reward_token) - arbiter_before,
        dec!("1"),
        "arbiter fee, paid to the arbiter who called"
    );
    assert_eq!(
        f.ledger.get_component_balance(f.worker_account, f.reward_token) - worker_before,
        dec!("0"),
        "PULL: the winning party is credited at settlement, not paid"
    );
    assert_eq!(
        f.ledger.get_component_balance(f.poster_account, f.reward_token) - poster_before,
        dec!("0"),
        "and the arbiter's manifest can no longer route the counterparty shares anywhere"
    );

    assert_eq!(fetch_entitlements(&mut f, 1), (dec!("109"), dec!("0")));
    // W5 (stage 5b): the bond is held to settlement and follows the REWARD
    // ruling proportionally — PayWorker returns it whole to the worker.
    assert_eq!(fetch_bond_entitlements(&mut f, 1), (dec!("1"), dec!("0")));
    assert_eq!(
        fetch_settlement_balances(&mut f, 1),
        (dec!("109"), dec!("1")),
        "both lanes conserve; the bond waits in its vault until collected"
    );

    let info = fetch_task(&mut f, 1);
    assert_eq!(info.state, TaskState::Released);
    assert_eq!(fetch_balances(&mut f, 1), (dec!("0"), dec!("0"), dec!("0")));

    // Collection, and the replay guard on it. Both lanes are the reward token
    // now, so one delta covers reward + insurance + bond.
    withdraw_worker(&mut f, 1).expect_commit_success();
    assert_eq!(
        f.ledger.get_component_balance(f.worker_account, f.reward_token) - worker_before,
        dec!("110"),
        "worker collects reward + remaining insurance + their bond back"
    );
    withdraw_worker(&mut f, 1).expect_commit_failure();
    assert_eq!(fetch_settlement_balances(&mut f, 1), (dec!("0"), dec!("0")));
}

#[test]
fn test_resolve_dispute_refund_poster() {
    let mut f = setup();
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));
    full_submit(&mut f, dec!("100"), dec!("10"), dec!("0.1"));
    raise_dispute_as_worker(&mut f, 1, None).expect_commit_success();

    let worker_before = f.ledger.get_component_balance(f.worker_account, f.reward_token);
    let poster_before = f.ledger.get_component_balance(f.poster_account, f.reward_token);
    let arbiter_before = f.ledger.get_component_balance(f.arbiter_account, f.reward_token);

    resolve_dispute_helper(&mut f, 1, DisputeRuling::RefundPoster).expect_commit_success();

    assert_eq!(
        f.ledger.get_component_balance(f.arbiter_account, f.reward_token) - arbiter_before,
        dec!("1"),
        "arbiter fee"
    );
    assert_eq!(
        f.ledger.get_component_balance(f.worker_account, f.reward_token) - worker_before,
        dec!("0"),
        "worker gets nothing on RefundPoster"
    );
    assert_eq!(
        f.ledger.get_component_balance(f.poster_account, f.reward_token) - poster_before,
        dec!("0"),
        "PULL: the poster is credited, then collects"
    );

    assert_eq!(fetch_entitlements(&mut f, 1), (dec!("0"), dec!("109")));
    // W5: proportional-to-the-reward-ruling means RefundPoster (worker share
    // 0) forfeits the WHOLE bond to the poster. An arbiter found the work
    // worth nothing; the anti-squat stake follows that judgement.
    assert_eq!(fetch_bond_entitlements(&mut f, 1), (dec!("0"), dec!("1")));
    assert_eq!(fetch_settlement_balances(&mut f, 1), (dec!("109"), dec!("1")));

    let info = fetch_task(&mut f, 1);
    assert_eq!(info.state, TaskState::Refunded);

    withdraw_poster(&mut f, 1).expect_commit_success();
    assert_eq!(
        f.ledger.get_component_balance(f.poster_account, f.reward_token) - poster_before,
        dec!("110"),
        "poster collects reward + remaining insurance + the forfeited bond"
    );
    withdraw_poster(&mut f, 1).expect_commit_failure();
}

#[test]
fn test_resolve_dispute_split_50_50() {
    let mut f = setup();
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));
    full_submit(&mut f, dec!("100"), dec!("10"), dec!("0.1"));
    raise_dispute_as_poster(&mut f, 1, None).expect_commit_success();

    let worker_before = f.ledger.get_component_balance(f.worker_account, f.reward_token);
    let poster_before = f.ledger.get_component_balance(f.poster_account, f.reward_token);
    let arbiter_before = f.ledger.get_component_balance(f.arbiter_account, f.reward_token);

    resolve_dispute_helper(
        &mut f,
        1,
        DisputeRuling::Split { worker_pct: dec!("0.5"), poster_pct: dec!("0.5") },
    )
    .expect_commit_success();

    // arbiter_fee = 1; remaining_insurance = 9
    // worker: 100*0.5 + 9*0.5 = 54.5   poster: the REMAINDER, also 54.5
    // bond (W5, follows the reward ruling): 1*0.5 each way
    assert_eq!(
        f.ledger.get_component_balance(f.arbiter_account, f.reward_token) - arbiter_before,
        dec!("1")
    );
    assert_eq!(fetch_entitlements(&mut f, 1), (dec!("54.5"), dec!("54.5")));
    assert_eq!(fetch_bond_entitlements(&mut f, 1), (dec!("0.5"), dec!("0.5")));
    assert_eq!(
        fetch_settlement_balances(&mut f, 1),
        (dec!("109"), dec!("1")),
        "each lane's halves are backed by that lane's vault holding exactly their sum"
    );

    let info = fetch_task(&mut f, 1);
    assert_eq!(info.state, TaskState::Released);

    // Both sides collect independently — the half a Split most needs proven,
    // since the poster's share is computed as the REMAINDER of a combined bucket
    // rather than from the ruling's arithmetic (in BOTH lanes).
    withdraw_worker(&mut f, 1).expect_commit_success();
    withdraw_poster(&mut f, 1).expect_commit_success();
    assert_eq!(
        f.ledger.get_component_balance(f.worker_account, f.reward_token) - worker_before,
        dec!("55")
    );
    assert_eq!(
        f.ledger.get_component_balance(f.poster_account, f.reward_token) - poster_before,
        dec!("55")
    );
    assert_eq!(fetch_settlement_balances(&mut f, 1), (dec!("0"), dec!("0")));
}

#[test]
fn test_resolve_dispute_split_invalid_pct_rejects() {
    let mut f = setup();
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));
    full_submit(&mut f, dec!("100"), dec!("10"), dec!("0.1"));
    raise_dispute_as_poster(&mut f, 1, None).expect_commit_success();

    // Sum != 1 — amounts don't matter, method rejects early
    let receipt = resolve_dispute_helper(
        &mut f,
        1,
        DisputeRuling::Split { worker_pct: dec!("0.7"), poster_pct: dec!("0.7") },
    );
    assert!(
        receipt.is_commit_failure(),
        "split percentages summing to > 1 must reject"
    );
}

#[test]
fn test_resolve_dispute_when_not_disputed_rejects() {
    let mut f = setup();
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));
    full_submit(&mut f, dec!("100"), dec!("10"), dec!("0.1"));
    // No raise_dispute — task is Submitted

    // Task not disputed — amounts don't matter, method rejects early
    let receipt = resolve_dispute_helper(&mut f, 1, DisputeRuling::PayWorker);
    assert!(receipt.is_commit_failure());
}

// ── PR 2.4 auto_resolve_dispute tests ───────────────────────────────────────

#[test]
fn test_auto_resolve_dispute_favor_raiser_worker() {
    // EXPLICIT FavorDisputeRaiser — not the deploy default (that is SplitEvenly
    // per the signed sheet); this pins the FDR enum arm's behavior for any
    // component that instantiates with it. Worker raised → PayWorker.
    let mut f = setup_with_default(AutoResolveDefault::FavorDisputeRaiser);
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));
    full_submit(&mut f, dec!("100"), dec!("10"), dec!("0.1"));
    raise_dispute_as_worker(&mut f, 1, None).expect_commit_success();

    let worker_before = f.ledger.get_component_balance(f.worker_account, f.reward_token);
    let poster_before = f.ledger.get_component_balance(f.poster_account, f.reward_token);

    advance_time_by_secs(&mut f.ledger, 1_209_601);
    auto_resolve_dispute(&mut f, 1).expect_commit_success();

    // ── THE ANONYMOUS-DRAIN FIX, ASSERTED DIRECTLY ──────────────────────────
    // auto_resolve_dispute is PUBLIC and takes a task_id and nothing else. It
    // used to return (worker_bucket, poster_bucket) TO THE CALLER, so anyone
    // could take both after the 72h window — ~3.3 XRD of gas for ~105 XRD.
    //
    // Here the POSTER is the caller and the ruling favours the WORKER, so if the
    // caller received anything at all this assertion moves. It does not.
    assert_eq!(
        f.ledger.get_component_balance(f.poster_account, f.reward_token) - poster_before,
        dec!("0"),
        "the caller receives NOTHING — this is the drain fix, not a formality"
    );
    assert_eq!(
        f.ledger.get_component_balance(f.worker_account, f.reward_token) - worker_before,
        dec!("0"),
        "and the rightful party is credited, not paid"
    );

    // ⚠️ THIS ASSERTION USED TO READ (110, 0), AND IT WAS DEFENDING A HOLE.
    // On AUTO-resolve nobody judged, so the ruling governs the REWARD only and
    // the insurance premium returns to the poster who paid it. The worker
    // therefore collects exactly what `approve_and_release` pays — see
    // `test_disputing_never_out_earns_being_approved`, which asserts that
    // relationship directly rather than restating these constants.
    assert_eq!(fetch_entitlements(&mut f, 1), (dec!("100"), dec!("10")));
    // W5: PayWorker on the reward ruling returns the whole bond to the worker.
    assert_eq!(fetch_bond_entitlements(&mut f, 1), (dec!("1"), dec!("0")));
    assert_eq!(fetch_settlement_balances(&mut f, 1), (dec!("110"), dec!("1")));

    let info = fetch_task(&mut f, 1);
    assert_eq!(info.state, TaskState::Released);

    withdraw_worker(&mut f, 1).expect_commit_success();
    assert_eq!(
        f.ledger.get_component_balance(f.worker_account, f.reward_token) - worker_before,
        dec!("101"),
        "only the worker's own credential can move it: the reward + their bond back"
    );
    withdraw_worker(&mut f, 1).expect_commit_failure();
}

/// The payoff table, asserted as a RELATIONSHIP rather than as constants.
///
/// This is the test that would have caught D-P4. The old `SplitEvenly` default
/// made disputing net the worker half the pot — strictly worse than completing
/// honestly — so the bad strategy was dominated away by accident. D-P4 replaced
/// that default for good reasons (SplitEvenly punishes the honest party 50% in
/// every case) and removed the accidental protection along with it: a
/// `PayWorker` ruling paid reward AND insurance, i.e. MORE than honest
/// completion, on every task.
///
/// The attack needs no sophistication. `raise_dispute` requires `Submitted` and
/// `submit_task` sets it, so a worker can submit and dispute in ONE manifest;
/// the first raise sets `Disputed`, locking the poster out of the race; and
/// `FavorDisputeRaiser` then hands the raiser the win after the window.
///
/// Asserting `dispute <= approve` rather than `dispute == 100` is deliberate: it
/// keeps holding if the reward, the insurance fraction or the default ruling
/// ever change, which is exactly the class of change that introduced the bug.
///
/// SITTING 2026-08-06 (DB-1): the deploy default is `SplitEvenly` again —
/// D-P4 reversed, D2 restored — so under the AMBIENT default self-disputing
/// now pays strictly LESS than honest completion (the original dominance
/// property, this time on purpose rather than by accident). The `<=` above is
/// the invariant that must survive any default; the exact pins below are what
/// go red if the ambient default ever drifts off the signed sheet.
#[test]
fn test_disputing_never_out_earns_being_approved() {
    let token_min = dec!("10");

    // Leg 1 — the honest path. What does completing the work pay?
    // BOTH lanes: since 5b the bond is held to settlement, so an honest
    // worker's take is reward + bond back — leaving the bond out of this
    // comparison would let a future bond-forfeit rule on the approve path
    // silently shrink the honest side while this test stayed green.
    let approve_pays = {
        let mut f = setup();
        let token = f.reward_token;
        add_token_to_whitelist(&mut f, token, token_min);
        full_submit(&mut f, dec!("100"), dec!("10"), dec!("0.1"));
        approve_and_release(&mut f, 1).expect_commit_success();
        fetch_entitlements(&mut f, 1).0 + fetch_bond_entitlements(&mut f, 1).0
    };

    // Leg 2 — the strategy. Same task, same worker, but they dispute their own
    // submission and wait out the window instead of being approved.
    let (dispute_pays, poster_gets) = {
        let mut f = setup();
        let token = f.reward_token;
        add_token_to_whitelist(&mut f, token, token_min);
        full_submit(&mut f, dec!("100"), dec!("10"), dec!("0.1"));
        raise_dispute_as_worker(&mut f, 1, None).expect_commit_success();
        advance_time_by_secs(&mut f.ledger, 1_209_601);
        auto_resolve_dispute(&mut f, 1).expect_commit_success();
        let (w, p) = fetch_entitlements(&mut f, 1);
        let (wb, pb) = fetch_bond_entitlements(&mut f, 1);
        (w + wb, p + pb)
    };

    assert!(
        dispute_pays <= approve_pays,
        "DISPUTE MUST NOT OUT-EARN HONEST COMPLETION. approve pays {}, \
         self-disputing pays {} — a worker who never intends to cooperate is \
         strictly better off, on every task, for the price of one extra method \
         call in the same manifest",
        approve_pays,
        dispute_pays
    );
    // SE-exact pins (reward 100, insurance 10, bond 1): a 50/50 reward split,
    // the premium back to the poster, and the bond following the reward ruling
    // 50/50 (W5). These numbers ARE the ambient-default guard — under
    // FavorDisputeRaiser the worker leg reads 101 and the poster leg 10, so a
    // drift of setup()'s default off the signed sheet reddens here.
    assert_eq!(
        dispute_pays,
        dec!("50.5"),
        "under the SplitEvenly deploy default, self-disputing pays HALF (of \
         reward AND bond) — strictly worse than the 101 honest completion pays"
    );
    assert_eq!(
        poster_gets,
        dec!("60.5"),
        "poster: 50 reward-half + the 10 insurance premium back + half the \
         bond — nobody judged, so the premium is never a prize"
    );
}

/// The counterpart: an ARBITER-ruled resolution DOES transfer the insurance,
/// because there a human looked at the work and found against the poster.
/// Without this test the fix above could be "simplified" into never transferring
/// insurance at all, which would silently delete the arbiter's only remedy.
#[test]
fn test_arbiter_ruling_still_transfers_insurance_to_the_worker() {
    let mut f = setup();
    let token = f.reward_token;
    add_token_to_whitelist(&mut f, token, dec!("10"));
    full_submit(&mut f, dec!("100"), dec!("10"), dec!("0.1"));
    raise_dispute_as_poster(&mut f, 1, None).expect_commit_success();

    // arbiter_fee_pct 0.1 on 10 insurance = 1 to the arbiter, 9 remaining.
    resolve_dispute_helper(&mut f, 1, DisputeRuling::PayWorker).expect_commit_success();

    let (worker_ent, poster_ent) = fetch_entitlements(&mut f, 1);
    assert_eq!(
        worker_ent,
        dec!("109"),
        "arbiter-ruled PayWorker: reward + insurance net of the arbiter fee"
    );
    assert_eq!(
        poster_ent,
        dec!("0"),
        "the poster keeps nothing when an arbiter rules against them — this is \
         the punitive transfer, and it is the ONLY path that should have it"
    );
}

#[test]
fn test_auto_resolve_dispute_return_to_poster() {
    let mut f = setup_with_default(AutoResolveDefault::ReturnToPoster);
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));
    full_submit(&mut f, dec!("100"), dec!("10"), dec!("0.1"));
    raise_dispute_as_worker(&mut f, 1, None).expect_commit_success();

    let worker_before = f.ledger.get_component_balance(f.worker_account, f.reward_token);
    let poster_before = f.ledger.get_component_balance(f.poster_account, f.reward_token);

    advance_time_by_secs(&mut f.ledger, 1_209_601);
    auto_resolve_dispute(&mut f, 1).expect_commit_success();

    assert_eq!(
        f.ledger.get_component_balance(f.worker_account, f.reward_token) - worker_before,
        dec!("0")
    );
    assert_eq!(
        f.ledger.get_component_balance(f.poster_account, f.reward_token) - poster_before,
        dec!("0"),
        "the poster is the caller here AND the beneficiary — still credited, not paid"
    );
    assert_eq!(fetch_entitlements(&mut f, 1), (dec!("0"), dec!("110")));
    // W5: ReturnToPoster maps to a RefundPoster reward ruling, and the bond
    // follows it — worker share 0, whole bond to the poster. Proportional cuts
    // both ways: a ruling that finds the work worth nothing forfeits the stake.
    assert_eq!(fetch_bond_entitlements(&mut f, 1), (dec!("0"), dec!("1")));
    assert_eq!(fetch_settlement_balances(&mut f, 1), (dec!("110"), dec!("1")));

    let info = fetch_task(&mut f, 1);
    assert_eq!(info.state, TaskState::Refunded);

    withdraw_poster(&mut f, 1).expect_commit_success();
    assert_eq!(
        f.ledger.get_component_balance(f.poster_account, f.reward_token) - poster_before,
        dec!("111")
    );
    withdraw_poster(&mut f, 1).expect_commit_failure();
}

#[test]
fn test_auto_resolve_dispute_split_evenly() {
    let mut f = setup_with_default(AutoResolveDefault::SplitEvenly);
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));
    full_submit(&mut f, dec!("100"), dec!("10"), dec!("0.1"));
    raise_dispute_as_poster(&mut f, 1, None).expect_commit_success();

    let worker_before = f.ledger.get_component_balance(f.worker_account, f.reward_token);
    let poster_before = f.ledger.get_component_balance(f.poster_account, f.reward_token);

    advance_time_by_secs(&mut f.ledger, 1_209_601);
    auto_resolve_dispute(&mut f, 1).expect_commit_success();

    // Settlement pays nobody; both parties are credited and then collect.
    assert_eq!(
        f.ledger.get_component_balance(f.worker_account, f.reward_token) - worker_before,
        dec!("0")
    );
    assert_eq!(
        f.ledger.get_component_balance(f.poster_account, f.reward_token) - poster_before,
        dec!("0")
    );
    // ⚠️ WAS (55, 55) — the insurance used to be split too. On AUTO-resolve the
    // ruling now governs the REWARD only (50/50 of 100), and the poster's 10
    // insurance premium comes back to them as part of the remainder: 50 / 60.
    // The arbiter-ruled 50/50 case is unchanged and still splits both legs, at
    // test_resolve_dispute_split_50_50 — the two differ precisely because one of
    // them had a human decide. The bond (W5) follows the reward ruling: 0.5 each.
    assert_eq!(fetch_entitlements(&mut f, 1), (dec!("50"), dec!("60")));
    assert_eq!(fetch_bond_entitlements(&mut f, 1), (dec!("0.5"), dec!("0.5")));
    assert_eq!(fetch_settlement_balances(&mut f, 1), (dec!("110"), dec!("1")));

    withdraw_worker(&mut f, 1).expect_commit_success();
    withdraw_poster(&mut f, 1).expect_commit_success();
    assert_eq!(
        f.ledger.get_component_balance(f.worker_account, f.reward_token) - worker_before,
        dec!("50.5")
    );
    assert_eq!(
        f.ledger.get_component_balance(f.poster_account, f.reward_token) - poster_before,
        dec!("60.5")
    );
    assert_eq!(fetch_settlement_balances(&mut f, 1), (dec!("0"), dec!("0")));
}

#[test]
fn test_auto_resolve_dispute_before_window_rejects() {
    let mut f = setup();
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));
    full_submit(&mut f, dec!("100"), dec!("10"), dec!("0.1"));
    raise_dispute_as_poster(&mut f, 1, None).expect_commit_success();

    // Before window — amounts don't matter, method rejects early
    let receipt = auto_resolve_dispute(&mut f, 1);
    assert!(
        receipt.is_commit_failure(),
        "auto-resolve before window must reject"
    );
}

#[test]
fn test_auto_resolve_dispute_when_not_disputed_rejects() {
    let mut f = setup();
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));
    create_task(&mut f, dec!("100"), dec!("10"), dec!("0.1")).expect_commit_success();

    advance_time_by_secs(&mut f.ledger, 10_000_000);
    // Not disputed — amounts don't matter, method rejects early
    let receipt = auto_resolve_dispute(&mut f, 1);
    assert!(
        receipt.is_commit_failure(),
        "auto-resolve on Open task must reject"
    );
}

// ── The self-dealing guard, narrow form (L6 ruled (c), 2026-08-30) ──────────

/// The guard's one job: an arbiter badge ASSIGNED TO THE WORKER'S ACCOUNT
/// cannot rule on that worker's dispute. worker_account is the only party
/// identity the comparison can honestly cover — it is named by the claimer in
/// the call that stakes their own bond, and every worker-side payout lands
/// there, so a decoy is self-defeating.
#[test]
fn test_resolve_rejects_an_arbiter_badge_assigned_to_the_worker() {
    let mut f = setup_with_arbiter_assigned_to(ArbiterAssignee::TheWorker);
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));
    full_submit(&mut f, dec!("100"), dec!("10"), dec!("0.1"));
    raise_dispute_as_poster(&mut f, 1, None).expect_commit_success();

    // The message, not a bare failure: wrong resource, wrong state and a bad
    // ruling shape all fail earlier in the same method.
    resolve_dispute_helper(&mut f, 1, DisputeRuling::PayWorker)
        .expect_commit_failure_containing_error(
            "self-dealing: the arbiter badge is assigned to this task's worker account",
        );

    // 🔴 The guard must not BRICK the dispute: with the sole arbiter refused,
    // the permissionless auto path still settles it. A guard that stranded
    // the money would be a worse defect than the one it closes.
    advance_time_by_secs(&mut f.ledger, 1_209_601);
    auto_resolve_dispute(&mut f, 1).expect_commit_success();
    assert_eq!(fetch_entitlements(&mut f, 1), (dec!("50"), dec!("60")));
}

/// The trade L6(c) makes, kept VISIBLE by a test: an arbiter badge assigned
/// to the POSTER's account still resolves. `task.poster` is a caller-supplied
/// parameter bound to nothing (M5), so a poster-side comparison would be
/// defeated by a decoy address for the cost of gas — a guard that reads as a
/// defence and is not one. Poster-side self-dealing is OPEN BY DESIGN and the
/// honesty copy must say so.
///
/// If this test starts FAILING, someone built the poster-side check: before
/// keeping it, either M5/L6 binding shipped too (then update the copy the
/// other way), or the guard is the decoy-defeatable shape this test exists
/// to keep out.
#[test]
fn test_resolve_accepts_an_arbiter_badge_assigned_to_the_poster_by_design() {
    let mut f = setup_with_arbiter_assigned_to(ArbiterAssignee::ThePoster);
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));
    full_submit(&mut f, dec!("100"), dec!("10"), dec!("0.1"));
    raise_dispute_as_worker(&mut f, 1, None).expect_commit_success();

    resolve_dispute_helper(&mut f, 1, DisputeRuling::RefundPoster).expect_commit_success();
    // And nothing is stealable even here: settlement credits only accounts
    // pinned at create/claim — an arbiter-poster rules, they do not route.
    assert_eq!(fetch_entitlements(&mut f, 1), (dec!("0"), dec!("109")));
}

/// 🔴 THE REVERT DETECTOR. Every other arbiter test drives the badge through
/// `create_proof_from_account_of_non_fungibles`, which works on a transferable
/// badge and a non-transferable one alike. That means they ALL still pass if
/// someone reverts this pair together — fixture back to a default-transferable
/// mint, `resolve_dispute` back to `arbiter_badge: Bucket` — silently
/// resurrecting the bug that made the method uncallable against the real badge.
/// Reviewed 2026-09-01; this test is the only thing in the suite that fails on
/// that revert.
///
/// It asserts the PREMISE rather than the consequence: the badge cannot be
/// withdrawn from the account that holds it. A Bucket parameter can only ever
/// be fed by a withdrawal, so a badge that refuses to be withdrawn is a badge
/// no bucket-shaped method can reach — which is exactly why the Proof form is
/// not a style preference.
///
/// Falsifying input, stated so this cannot be a test that passes vacuously:
/// delete `withdrawer => rule!(deny_all)` from the fixture's mint and this
/// withdrawal COMMITS, failing the assertion below.
#[test]
fn test_arbiter_badge_cannot_be_withdrawn_so_no_bucket_form_can_ever_reach_it() {
    let mut f = setup();

    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .withdraw_non_fungibles_from_account(
            f.arbiter_account,
            f.arbiter_badge,
            indexset![NonFungibleLocalId::integer(1)],
        )
        .try_deposit_entire_worktop_or_abort(f.arbiter_account, None)
        .build();
    let receipt = f.ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&f.arbiter_pk)],
    );

    // The badge's own withdrawer rule refuses, so this is an AUTH failure —
    // not "the arbiter happened to lack a signature", which is why the
    // manifest above is signed by the arbiter who actually holds it.
    receipt.expect_commit_failure();

    // And the Proof path over the same badge still works, so the refusal above
    // is the resource's transfer rule and not a broken fixture.
    let token = f.reward_token;
    add_token_to_whitelist(&mut f, token, dec!("10"));
    full_submit(&mut f, dec!("100"), dec!("10"), dec!("0.1"));
    raise_dispute_as_poster(&mut f, 1, None).expect_commit_success();
    resolve_dispute_helper(&mut f, 1, DisputeRuling::PayWorker).expect_commit_success();
}

// ── PR 2.5 view + invariant tests ──────────────────────────────────────────

/// House-vault balance for the REWARD token — the only resource bonds are
/// denominated in under this fixture. The getter is per-resource since the
/// forfeit vaults became a KVS keyed by resource (stage 1's forfeit-vault KVS).
fn fetch_forfeited(f: &mut Fixture) -> Decimal {
    let token = f.reward_token;
    f.ledger
        .call_method(f.escrow, "get_forfeited_bond_amount", manifest_args!(token))
        .expect_commit_success()
        .output(1)
}

fn approve_and_release(f: &mut Fixture, task_id: u64) -> TransactionReceipt {
    let receipt_nf_id = NonFungibleLocalId::integer(task_id);
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        // PULL: a Proof, not a Bucket. The receipt is never withdrawn and is
        // never burned — the poster still needs it to withdraw the insurance.
        .create_proof_from_account_of_non_fungibles(
            f.poster_account,
            f.task_receipt_resource,
            indexset![receipt_nf_id],
        )
        .pop_from_auth_zone("receipt")
        .call_method_with_name_lookup(f.escrow, "approve_and_release", |lookup| {
            (lookup.proof("receipt"),)
        })
        .call_method(
            f.poster_account,
            "deposit_batch",
            manifest_args!(ManifestExpression::EntireWorktop),
        )
        .build();
    f.ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&f.poster_pk)],
    )
}

#[test]
fn test_get_forfeited_bond_amount_starts_zero() {
    let mut f = setup();
    assert_eq!(fetch_forfeited(&mut f), Decimal::ZERO);
}

/// The bounty below one whole token. This test USED to pin DB-4's `min(1 XRD,
/// bond)` cliff — a bond smaller than the flat bounty paid out whole to the
/// caller. Stage 5 DELETED that edge along with the flat bounty: the bounty is
/// `expire_bounty_pct * bond`, which by construction can never exceed the
/// bond, so there is no cliff left to pin. What replaces it: proportionality
/// stays exact below 1 (0.9 → 0.09 caller / 0.81 house) and the house leg is
/// genuinely nonzero even for a sub-unit bond — the exact opposite of the old
/// edge, and the assert that reddens if anyone reintroduces a flat floor.
#[test]
fn test_expire_bounty_stays_proportional_below_one_token() {
    let mut f = setup_with_bond(SUB_UNIT_BOND);
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));
    create_task(&mut f, dec!("100"), dec!("10"), dec!("0.1")).expect_commit_success();
    claim_task(&mut f, 1).expect_commit_success();

    assert_eq!(
        fetch_forfeited(&mut f),
        Decimal::ZERO,
        "nothing reaches the house before an expire — after DB-3 there is no fee leg"
    );

    advance_past_expire_grace(&mut f.ledger);
    let caller_before = f.ledger.get_component_balance(f.arbiter_account, f.reward_token);
    expire_claim(&mut f, 1).expect_commit_success();

    assert_eq!(
        f.ledger.get_component_balance(f.arbiter_account, f.reward_token) - caller_before,
        dec!("0.09"),
        "expire_bounty_pct of a 0.9 bond — a flat 1-unit floor would read 0.9 here"
    );
    assert_eq!(
        fetch_forfeited(&mut f),
        dec!("0.81"),
        "the house takes the remainder — nonzero even below one token"
    );
    assert_eq!(
        fetch_bond_entitlements(&mut f, 1),
        (dec!("0"), dec!("0")),
        "DB-4: an expired bond is never anyone's entitlement — least of all the poster's"
    );
}

/// DB-4 end to end (sitting 2026-08-06, replacing the D-P4 flow this test used
/// to pin): the expired bond leaves the POSTER nothing — no entitlement in
/// either lane, no settlement balance, and a withdraw attempt fails. The
/// reward-lane asserts are kept verbatim from the D-P4 era: they are what
/// caught phase 2 putting XRD into the reward lane on this path, and that
/// regression is default- and ruling-independent.
#[test]
fn test_expired_bond_leaves_the_poster_nothing_to_withdraw() {
    let mut f = setup();
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));
    create_task(&mut f, dec!("100"), dec!("10"), dec!("0.1")).expect_commit_success();
    claim_task(&mut f, 1).expect_commit_success();
    advance_past_expire_grace(&mut f.ledger);

    expire_claim(&mut f, 1).expect_commit_success();

    // The reward lane is untouched: the task went back to Open with the reward
    // still escrowed — and under DB-4 the bond lane settled to caller + house,
    // not to any party's entitlement.
    assert_eq!(fetch_entitlements(&mut f, 1), (dec!("0"), dec!("0")));
    assert_eq!(fetch_bond_entitlements(&mut f, 1), (dec!("0"), dec!("0")));
    assert_eq!(fetch_settlement_balances(&mut f, 1), (dec!("0"), dec!("0")));
    assert_eq!(fetch_balances(&mut f, 1).0, dec!("100"), "reward still escrowed");

    // The farming vector, asserted at the exit: a poster who engineered this
    // expiry has NOTHING to withdraw — both lanes empty, combined check fails.
    withdraw_poster(&mut f, 1).expect_commit_failure();
}

/// The entitlement guard on `burn_task_receipt`, observed through the lane
/// that can still fire.
///
/// HISTORY: this test used to arm the guard via an expired-claim bond credited
/// to the poster — the two-lane trap that `total_owed_to_poster` was written
/// for. DB-4 (sitting 2026-08-06) removed the poster-bond credit ON EXPIRY
/// (expire pays caller + house), so that particular arming state is gone.
///
/// ⚠️ This block used to end "any future path that credits a poster bond is
/// covered the day it appears". That day arrived: W5 (operator ruling
/// 2026-08-29) splits the claim bond proportionally on a dispute ruling, so
/// `credit_split_for_parties` credits `poster_bond_entitled` and the task
/// lands terminal — exactly the state the guard was written for.
/// `test_resolve_dispute_refund_poster` pins it at `(0, 1)` and
/// `test_resolve_dispute_split_50_50` at `(0.5, 0.5)`. The combined two-lane
/// read is therefore LOAD-BEARING today, not defense-in-depth against a
/// hypothetical. The observable case below is still the reward/insurance lane:
/// after approve, the poster is owed the insurance until they withdraw, and
/// burning the receipt then would strand it. The receipt is minted once per
/// task and cannot be re-minted.
#[test]
fn test_burn_receipt_rejects_while_the_poster_is_owed() {
    let mut f = setup();
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));
    full_submit(&mut f, dec!("100"), dec!("10"), dec!("0.1"));
    approve_and_release(&mut f, 1).expect_commit_success();

    assert_eq!(
        fetch_entitlements(&mut f, 1),
        (dec!("100"), dec!("10")),
        "post-approve: worker owed the reward, poster owed the insurance"
    );

    // Assert the REASON, not merely that it failed. The task is Released
    // (terminal), so the terminal-state guard PASSES this task — only the
    // entitlement guard can produce this message. A regression that stops
    // reading the poster's owed total would let the burn through and strand
    // the insurance.
    burn_task_receipt(&mut f, 1)
        .expect_commit_failure_containing_error("while the poster is still owed");

    // And the receipt still works, which is the half that matters.
    withdraw_poster(&mut f, 1).expect_commit_success();
}

/// The pre-existing variant of the same hole: on an Open task BOTH lanes are
/// legitimately zero, so an entitlement-only guard would let the poster burn the
/// receipt and strand the full funded reward.
#[test]
fn test_burn_receipt_rejects_before_the_task_is_terminal() {
    let mut f = setup();
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));
    create_task(&mut f, dec!("100"), dec!("10"), dec!("0.1")).expect_commit_success();

    assert_eq!(fetch_entitlements(&mut f, 1), (dec!("0"), dec!("0")));
    assert_eq!(fetch_bond_entitlements(&mut f, 1), (dec!("0"), dec!("0")));
    assert_eq!(fetch_balances(&mut f, 1).0, dec!("100"), "and 100 is escrowed");

    // Nothing is owed in either lane here, so the entitlement guard passes and
    // ONLY the terminal-state guard can reject. Asserting the message is what
    // makes this test specific to that guard rather than to burning in general.
    burn_task_receipt(&mut f, 1)
        .expect_commit_failure_containing_error("before the task is terminal");
    assert_eq!(fetch_task(&mut f, 1).state, TaskState::Open);
}

/// The permitted case, so the two rejections above are not just a method that
/// always refuses.
#[test]
fn test_burn_receipt_succeeds_once_terminal_and_fully_collected() {
    let mut f = setup();
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));
    full_submit(&mut f, dec!("100"), dec!("10"), dec!("0.1"));
    approve_and_release(&mut f, 1).expect_commit_success();

    // Terminal, but the poster still holds a 10 insurance entitlement.
    burn_task_receipt(&mut f, 1)
        .expect_commit_failure_containing_error("while the poster is still owed");

    withdraw_poster(&mut f, 1).expect_commit_success();
    assert_eq!(fetch_entitlements(&mut f, 1).1, dec!("0"));
    burn_task_receipt(&mut f, 1).expect_commit_success();
}

// Terminal-state invariant: once Released or Refunded, no mutating method succeeds

#[test]
fn test_released_task_rejects_further_cancel() {
    let mut f = setup();
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));
    full_submit(&mut f, dec!("100"), dec!("10"), dec!("0.1"));
    approve_and_release(&mut f, 1).expect_commit_success();

    let info = fetch_task(&mut f, 1);
    assert_eq!(info.state, TaskState::Released);

    // task_receipt was burned by approve_and_release, so the manifest below
    // will fail at withdraw_non_fungibles_from_account. That's still a
    // commit-failure (the desired invariant).
    let receipt = cancel_task_by_poster_after_claim(&mut f, 1);
    assert!(
        receipt.is_commit_failure(),
        "no cancel on Released task"
    );
}

#[test]
fn test_refunded_task_rejects_further_claim() {
    let mut f = setup();
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));
    create_task(&mut f, dec!("100"), dec!("10"), dec!("0.1")).expect_commit_success();

    // Cancel (Open → Refunded). poster_receipt burned, vaults emptied.
    let cancel_manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .create_proof_from_account_of_non_fungibles(
            f.poster_account,
            f.task_receipt_resource,
            indexset![NonFungibleLocalId::integer(1)],
        )
        .pop_from_auth_zone("receipt")
        .call_method_with_name_lookup(f.escrow, "cancel_task", |lookup| (lookup.proof("receipt"),))
        .call_method(
            f.poster_account,
            "deposit_batch",
            manifest_args!(ManifestExpression::EntireWorktop),
        )
        .build();
    f.ledger
        .execute_manifest(
            cancel_manifest,
            vec![NonFungibleGlobalId::from_public_key(&f.poster_pk)],
        )
        .expect_commit_success();

    let info = fetch_task(&mut f, 1);
    assert_eq!(info.state, TaskState::Refunded);

    let claim_receipt = claim_task(&mut f, 1);
    assert!(
        claim_receipt.is_commit_failure(),
        "claim on Refunded task must reject"
    );
}

#[test]
fn test_approve_twice_second_rejects() {
    let mut f = setup();
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));
    full_submit(&mut f, dec!("100"), dec!("10"), dec!("0.1"));
    approve_and_release(&mut f, 1).expect_commit_success();

    // task_receipt is burned; approve_and_release would fail at
    // withdraw_non_fungibles_from_account in the manifest.
    let receipt = approve_and_release(&mut f, 1);
    assert!(
        receipt.is_commit_failure(),
        "approve on Released task must reject"
    );
}

// claim_bond exactness invariant

#[test]
fn test_claim_bond_too_low_rejects() {
    let mut f = setup();
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));
    create_task(&mut f, dec!("100"), dec!("10"), dec!("0.1")).expect_commit_success();

    // Try to claim with 0.5 XRD instead of required 1 XRD
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .create_proof_from_account_of_non_fungibles(
            f.worker_account,
            f.worker_badge,
            vec![NonFungibleLocalId::integer(1)],
        )
        .pop_from_auth_zone("worker_proof")
        .withdraw_from_account(f.worker_account, f.reward_token, dec!("0.5"))
        .take_from_worktop(f.reward_token, dec!("0.5"), "bond")
        .call_method_with_name_lookup(f.escrow, "claim_task", |lookup| {
            (1u64, f.worker_account, lookup.proof("worker_proof"), lookup.bucket("bond"))
        })
        .call_method(
            f.worker_account,
            "deposit_batch",
            manifest_args!(ManifestExpression::EntireWorktop),
        )
        .build();
    let receipt = f.ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&f.worker_pk)],
    );
    // Assert the REASON, not merely that something failed: a bare
    // is_commit_failure() passes when the manifest is malformed, the badge is
    // wrong, or the task id does not exist — none of which exercise the bond rule.
    receipt.expect_commit_failure_containing_error("claim_bond amount does not match required");
}

#[test]
fn test_claim_bond_too_high_rejects() {
    let mut f = setup();
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));
    create_task(&mut f, dec!("100"), dec!("10"), dec!("0.1")).expect_commit_success();

    // 5 instead of the required 1
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .create_proof_from_account_of_non_fungibles(
            f.worker_account,
            f.worker_badge,
            vec![NonFungibleLocalId::integer(1)],
        )
        .pop_from_auth_zone("worker_proof")
        .withdraw_from_account(f.worker_account, f.reward_token, dec!("5"))
        .take_from_worktop(f.reward_token, dec!("5"), "bond")
        .call_method_with_name_lookup(f.escrow, "claim_task", |lookup| {
            (1u64, f.worker_account, lookup.proof("worker_proof"), lookup.bucket("bond"))
        })
        .call_method(
            f.worker_account,
            "deposit_batch",
            manifest_args!(ManifestExpression::EntireWorktop),
        )
        .build();
    let receipt = f.ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&f.worker_pk)],
    );
    receipt.expect_commit_failure_containing_error("claim_bond amount does not match required");
}

#[test]
fn test_claim_bond_wrong_resource_rejects() {
    // ⚠️ INVERTED at stage 5a. This test used to stake the reward token and
    // expect "claim_bond must be XRD"; the bond is denominated in the task's
    // reward token now, so the WRONG resource is XRD — which is exactly the
    // bond every pre-5a caller (and manifest builder) still stakes. This is
    // the failure an un-migrated client will actually hit.
    let mut f = setup();
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));
    create_task(&mut f, dec!("100"), dec!("10"), dec!("0.1")).expect_commit_success();

    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .create_proof_from_account_of_non_fungibles(
            f.worker_account,
            f.worker_badge,
            vec![NonFungibleLocalId::integer(1)],
        )
        .pop_from_auth_zone("worker_proof")
        .withdraw_from_account(f.worker_account, XRD, dec!("1"))
        .take_from_worktop(XRD, dec!("1"), "bond")
        .call_method_with_name_lookup(f.escrow, "claim_task", |lookup| {
            (1u64, f.worker_account, lookup.proof("worker_proof"), lookup.bucket("bond"))
        })
        .build();
    let receipt = f.ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&f.worker_pk)],
    );
    // The resource assert fires BEFORE the amount assert in claim_task, so
    // this needle is what distinguishes this test from the two above it.
    receipt.expect_commit_failure_containing_error("claim_bond must be the task's reward token");
}

// ── Stage 5a/5b bond behavior: proportional sizing + held to settlement ──────

/// 5b's behavioral half, on the ledger. The SOURCE guard
/// (`test_submit_task_returns_nothing`) pins the signature; this pins what the
/// signature change was FOR: submitting moves no money at all. The bond stays
/// in its vault, nothing is credited to either party, and the worker's balance
/// is untouched by their own submit.
#[test]
fn test_submit_moves_no_money_and_the_bond_stays_in_its_vault() {
    let mut f = setup();
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));
    create_task(&mut f, dec!("100"), dec!("10"), dec!("0.1")).expect_commit_success();
    claim_task(&mut f, 1).expect_commit_success();

    let worker_before = f.ledger.get_component_balance(f.worker_account, f.reward_token);

    submit_task(&mut f, 1, 1).expect_commit_success();

    assert_eq!(
        f.ledger.get_component_balance(f.worker_account, f.reward_token) - worker_before,
        dec!("0"),
        "the bond does NOT come back at submit — it is held to settlement"
    );
    assert_eq!(
        fetch_balances(&mut f, 1).2,
        dec!("1"),
        "the bond vault still holds the full bond after submit"
    );
    assert_eq!(
        fetch_bond_entitlements(&mut f, 1),
        (dec!("0"), dec!("0")),
        "and nothing is credited until a settlement path decides where it goes"
    );
}

/// `required_bond = clamp(pct * reward, floor, cap)` — all three regimes, each
/// proven to BIND by rejecting the unclamped product first. A success leg
/// alone would stay green if the clamp were deleted and the caller just
/// happened to send the clamped number.
#[test]
fn test_claim_bond_is_proportional_with_floor_and_cap() {
    let mut f = setup_bond_params("0.1", "0.5", "5", 18);
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("0"));
    create_task(&mut f, dec!("30"), dec!("3"), dec!("0.1")).expect_commit_success();
    create_task(&mut f, dec!("2"), dec!("1"), dec!("0.1")).expect_commit_success();
    create_task(&mut f, dec!("100"), dec!("10"), dec!("0.1")).expect_commit_success();

    // In range: 0.1 * 30 = 3.
    claim_task_with_bond(&mut f, 1, dec!("3")).expect_commit_success();
    assert_eq!(fetch_balances(&mut f, 1).2, dec!("3"));

    // Floor binds: 0.1 * 2 = 0.2 → clamps UP to 0.5.
    claim_task_with_bond(&mut f, 2, dec!("0.2"))
        .expect_commit_failure_containing_error("claim_bond amount does not match required");
    claim_task_with_bond(&mut f, 2, dec!("0.5")).expect_commit_success();
    assert_eq!(fetch_balances(&mut f, 2).2, dec!("0.5"));

    // Cap binds: 0.1 * 100 = 10 → clamps DOWN to 5.
    claim_task_with_bond(&mut f, 3, dec!("10"))
        .expect_commit_failure_containing_error("claim_bond amount does not match required");
    claim_task_with_bond(&mut f, 3, dec!("5")).expect_commit_success();
    assert_eq!(fetch_balances(&mut f, 3).2, dec!("5"));
}

/// The REQUIREMENT itself must round down to the token's divisibility — on a
/// 6dp token an unrounded `pct * reward` routinely carries more places than
/// any bucket can hold, so without the round in `required_bond` NO bond could
/// ever match and every claim on such a task would be unfulfillable.
#[test]
fn test_claim_bond_requirement_rounds_down_to_the_tokens_divisibility() {
    let mut f = setup_bond_params("0.1", "0", "1000000", 6);
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("0"));
    // 0.1 * 33.333333 = 3.3333333 — seven places on a six-place token.
    create_task(&mut f, dec!("33.333333"), dec!("3"), dec!("0.1")).expect_commit_success();
    claim_task_with_bond(&mut f, 1, dec!("3.333333")).expect_commit_success();
    assert_eq!(fetch_balances(&mut f, 1).2, dec!("3.333333"));
}

/// pct=0, floor=0, cap=0 is a legitimate configuration ("bond params can
/// legitimately be zero" — the `drop_empty` branch in
/// `credit_split_for_parties`). The claim stakes an EMPTY bucket, settlement
/// credits no zero-amount bond entitlements, and collection still works.
#[test]
fn test_zero_bond_config_claims_and_settles_clean() {
    let mut f = setup_bond_params("0", "0", "0", 18);
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));
    create_task(&mut f, dec!("100"), dec!("10"), dec!("0.1")).expect_commit_success();

    claim_task_with_bond(&mut f, 1, dec!("0")).expect_commit_success();
    assert_eq!(fetch_balances(&mut f, 1).2, dec!("0"), "nothing staked");

    submit_task(&mut f, 1, 1).expect_commit_success();
    // The dispute path is the one that runs the drop_empty branch.
    raise_dispute_as_poster(&mut f, 1, None).expect_commit_success();
    advance_time_by_secs(&mut f.ledger, 1_209_601);
    auto_resolve_dispute(&mut f, 1).expect_commit_success();

    assert_eq!(
        fetch_bond_entitlements(&mut f, 1),
        (dec!("0"), dec!("0")),
        "a zero bond credits no entitlement — dropped, not booked"
    );
    assert_eq!(fetch_settlement_balances(&mut f, 1).1, dec!("0"));
    withdraw_worker(&mut f, 1).expect_commit_success();
}

// ── Stage 6: the review window (W2) + submission validation (P4-3) ───────────

/// Submit with CHOSEN evidence + brief hashes — for the validation tests.
/// The main `submit_task` helper always sends valid ones.
fn submit_task_with(
    f: &mut Fixture,
    task_id: u64,
    claim_receipt_id: u64,
    evidence: Hash,
    brief: Hash,
) -> TransactionReceipt {
    let receipt_nf_id = NonFungibleLocalId::integer(claim_receipt_id);
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .withdraw_non_fungibles_from_account(
            f.worker_account,
            f.claim_receipt_resource,
            indexset![receipt_nf_id],
        )
        .take_all_from_worktop(f.claim_receipt_resource, "claim_receipt")
        .call_method_with_name_lookup(f.escrow, "submit_task", |lookup| {
            (task_id, lookup.bucket("claim_receipt"), evidence, brief)
        })
        .call_method(
            f.worker_account,
            "deposit_batch",
            manifest_args!(ManifestExpression::EntireWorktop),
        )
        .build();
    f.ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&f.worker_pk)],
    )
}

/// Signed by the ARBITER account — a bystander who is neither party, same
/// reasoning as the expire_claim helper: it proves the caller's identity is
/// irrelevant AND that the caller receives nothing.
fn release_after_review_timeout(f: &mut Fixture, task_id: u64) -> TransactionReceipt {
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .call_method(f.escrow, "release_after_review_timeout", manifest_args!(task_id))
        .call_method(
            f.arbiter_account,
            "deposit_batch",
            manifest_args!(ManifestExpression::EntireWorktop),
        )
        .build();
    f.ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&f.arbiter_pk)],
    )
}

#[test]
fn test_submit_rejects_zero_evidence_hash() {
    let mut f = setup();
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));
    create_task(&mut f, dec!("100"), dec!("10"), dec!("0.1")).expect_commit_success();
    claim_task(&mut f, 1).expect_commit_success();

    // The message, not a bare failure: a wrong receipt or state fails earlier.
    submit_task_with(&mut f, 1, 1, Hash([0u8; 32]), WORK_BRIEF)
        .expect_commit_failure_containing_error("submission must commit a non-zero evidence hash");

    // And the same receipt still submits fine with real evidence — the
    // rejection consumed nothing.
    submit_task(&mut f, 1, 1).expect_commit_success();
}

#[test]
fn test_submit_rejects_wrong_brief_hash() {
    // P4-3's on-chain leg: the submission must name the brief it answers.
    // A client that built against a stale or different brief fails HERE, in
    // its own transaction, instead of surfacing later as a dispute.
    let mut f = setup();
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));
    create_task(&mut f, dec!("100"), dec!("10"), dec!("0.1")).expect_commit_success();
    claim_task(&mut f, 1).expect_commit_success();

    submit_task_with(&mut f, 1, 1, Hash([1u8; 32]), Hash([0xEE; 32]))
        .expect_commit_failure_containing_error(
            "brief_hash does not match the task's committed work_brief_hash",
        );

    submit_task(&mut f, 1, 1).expect_commit_success();
}

#[test]
fn test_release_after_review_timeout_before_deadline_rejects() {
    let mut f = setup();
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));
    full_submit(&mut f, dec!("100"), dec!("10"), dec!("0.1"));

    // Strictly inside the window.
    advance_time_by_secs(&mut f.ledger, (REVIEW_WINDOW_SECS as i64) / 2);
    release_after_review_timeout(&mut f, 1)
        .expect_commit_failure_containing_error("review window has not elapsed");

    // And on a task that is not Submitted at all.
    create_task(&mut f, dec!("100"), dec!("10"), dec!("0.1")).expect_commit_success();
    release_after_review_timeout(&mut f, 2)
        .expect_commit_failure_containing_error("task must be Submitted");
}

#[test]
fn test_release_after_review_timeout_pays_exactly_what_approve_pays() {
    // THE W2 PROPERTY: silence is approval, never a judgement. The lapsed
    // window must pay the worker reward + bond and the poster their insurance
    // — approve_and_release's exact split — and the CALLER nothing, because a
    // timeout that paid more than approval would resurrect the dominance bug
    // on a path any worker can reach alone.
    let mut f = setup();
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));
    full_submit(&mut f, dec!("100"), dec!("10"), dec!("0.1"));

    let worker_before = f.ledger.get_component_balance(f.worker_account, f.reward_token);
    let caller_before = f.ledger.get_component_balance(f.arbiter_account, f.reward_token);

    advance_time_by_secs(&mut f.ledger, (REVIEW_WINDOW_SECS as i64) + 1);
    release_after_review_timeout(&mut f, 1).expect_commit_success();

    assert_eq!(
        f.ledger.get_component_balance(f.arbiter_account, f.reward_token) - caller_before,
        dec!("0"),
        "the caller receives NOTHING — this settles by credit, like every PULL path"
    );
    assert_eq!(fetch_task(&mut f, 1).state, TaskState::Released);
    assert_eq!(fetch_entitlements(&mut f, 1), (dec!("100"), dec!("10")));
    assert_eq!(fetch_bond_entitlements(&mut f, 1), (dec!("1"), dec!("0")));
    assert_eq!(fetch_settlement_balances(&mut f, 1), (dec!("110"), dec!("1")));

    // Replay guard: a second firing must fail on state.
    release_after_review_timeout(&mut f, 1).expect_commit_failure();

    withdraw_worker(&mut f, 1).expect_commit_success();
    withdraw_poster(&mut f, 1).expect_commit_success();
    assert_eq!(
        f.ledger.get_component_balance(f.worker_account, f.reward_token) - worker_before,
        dec!("101"),
        "worker collects reward + bond — exactly the honest-approval payout"
    );
}

#[test]
fn test_poster_can_still_dispute_after_the_window_until_release_fires() {
    // First-to-commit past the deadline, by design: the window is the
    // poster's guaranteed floor, not a cutoff on their remedy — the mirror of
    // the arbiter's post-lapse overrule on the auto-resolve path.
    let mut f = setup();
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));
    full_submit(&mut f, dec!("100"), dec!("10"), dec!("0.1"));

    advance_time_by_secs(&mut f.ledger, (REVIEW_WINDOW_SECS as i64) + 1);
    raise_dispute_as_poster(&mut f, 1, None).expect_commit_success();

    // The dispute won the race; the release path is now closed.
    release_after_review_timeout(&mut f, 1)
        .expect_commit_failure_containing_error("task must be Submitted");
}

#[test]
fn test_review_window_is_pinned_at_submit() {
    // The non-retroactivity discipline, third instance: a tune of
    // review_window_secs after submit must not move a deadline the poster is
    // already reviewing under — in EITHER direction.
    let mut f = setup();
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));
    full_submit(&mut f, dec!("100"), dec!("10"), dec!("0.1"));

    // Owner stretches the window to the 30d maximum AFTER the submit.
    let manifest = owner_proof_manifest(&f)
        .call_method(f.escrow, "set_review_window_secs", manifest_args!(2_592_000u64))
        .build();
    f.ledger
        .execute_manifest(
            manifest,
            vec![NonFungibleGlobalId::from_public_key(&f.owner_pk)],
        )
        .expect_commit_success();

    // The PINNED 3d deadline governs: release succeeds long before 30d.
    advance_time_by_secs(&mut f.ledger, (REVIEW_WINDOW_SECS as i64) + 1);
    release_after_review_timeout(&mut f, 1).expect_commit_success();
    assert_eq!(fetch_task(&mut f, 1).state, TaskState::Released);
}

#[test]
fn test_set_review_window_secs_rejects_out_of_bounds() {
    let mut f = setup();
    for bad in [0u64, 86_399, 2_592_001] {
        let manifest = owner_proof_manifest(&f)
            .call_method(f.escrow, "set_review_window_secs", manifest_args!(bad))
            .build();
        f.ledger
            .execute_manifest(
                manifest,
                vec![NonFungibleGlobalId::from_public_key(&f.owner_pk)],
            )
            .expect_commit_failure_containing_error(
                "review_window_secs must be between 1 and 30 days",
            );
    }
}

#[test]
fn test_instantiate_rejects_out_of_bounds_review_window() {
    let mut ledger = LedgerSimulatorBuilder::new().build();
    let (owner_pk, _, owner_account) = ledger.new_allocated_account();
    let package_address = ledger.compile_and_publish(this_package!());
    let worker_badge = ledger.create_fungible_resource(dec!("1"), DIVISIBILITY_NONE, owner_account);
    let arbiter_badge = ledger.create_fungible_resource(dec!("1"), DIVISIBILITY_NONE, owner_account);

    // A zero window makes every submit instantly releasable — the faucet
    // shape this bound exists to keep unreachable by accident.
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .call_function(
            package_address,
            "Escrow",
            "instantiate",
            manifest_args!(
                worker_badge,
                arbiter_badge,
                None::<ResourceAddress>,
                dec!("0.1"),
                604800u64,
                86400u64,
                1209600u64,
                EXPIRE_GRACE_SECS,
                AutoResolveDefault::SplitEvenly,
                dec!("0.05"),
                dec!("0.1"),
                dec!("0.5"),
                dec!("5"),
                dec!("0.1"),
                0u64,
            ),
        )
        .build();
    let receipt = ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&owner_pk)],
    );
    receipt.expect_commit_failure_containing_error("review_window_secs must be between 1 and 30 days");
}

// Whitelist mutation safety: freeze blocks new tasks but doesn't kill in-flight ones

#[test]
fn test_freeze_token_does_not_break_inflight_task() {
    let mut f = setup();
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));
    create_task(&mut f, dec!("100"), dec!("10"), dec!("0.1")).expect_commit_success();
    claim_task(&mut f, 1).expect_commit_success();

    // Freeze the token AFTER claim
    let freeze = owner_proof_manifest(&f)
        .call_method(f.escrow, "freeze_token", manifest_args!(f.reward_token))
        .build();
    f.ledger
        .execute_manifest(freeze, vec![NonFungibleGlobalId::from_public_key(&f.owner_pk)])
        .expect_commit_success();

    // In-flight: submit + approve should still succeed
    submit_task(&mut f, 1, 1).expect_commit_success();
    approve_and_release(&mut f, 1).expect_commit_success();

    let info = fetch_task(&mut f, 1);
    assert_eq!(info.state, TaskState::Released);

    // But NEW tasks are blocked
    let receipt = create_task(&mut f, dec!("100"), dec!("10"), dec!("0.1"));
    assert!(
        receipt.is_commit_failure(),
        "create_task on frozen token must reject"
    );
}

// Submit with orphan claim_receipt from cancel-after-claim path

#[test]
fn test_submit_with_orphan_after_cancel_after_claim_rejects() {
    let mut f = setup();
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));
    create_task(&mut f, dec!("100"), dec!("10"), dec!("0.1")).expect_commit_success();
    claim_task(&mut f, 1).expect_commit_success();
    cancel_task_by_poster_after_claim(&mut f, 1).expect_commit_success();

    // Orphan claim_receipt #1 is still in worker's wallet (cancel-after-claim
    // doesn't burn it). Task is now Refunded. Submit must reject.
    let receipt = submit_task(&mut f, 1, 1);
    assert!(
        receipt.is_commit_failure(),
        "submit with orphan from cancel-after-claim must reject"
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ADVERSARIAL: the money path is routed by the MANIFEST, not by the blueprint
// ═══════════════════════════════════════════════════════════════════════════════
//
// These tests DOCUMENT a live hole rather than fix it — the same "document, don't
// fix" convention this repo already uses for known gaps. They assert the ATTACK
// SUCCEEDS against the blueprint as deployed (readiness M4 + REDESIGN BUG-7).
//
// **When the money path is fixed to enforce destinations on-chain, these MUST be
// inverted** (attacker delta 0, or expect_commit_failure). They are the regression
// tripwire, and they are deliberately loud so the fix cannot land silently.
//
// One root cause behind both, and behind the poster-drains-a-contribution-pool
// finding in docs/audits/vps-mvp-drafts-review.md: `approve_and_release` and
// `cancel_task_by_poster_after_claim` `take_all()` their vaults and RETURN the
// buckets to the caller. The blueprint records `poster` and the claim receipt's
// `worker` — it simply never uses them as deposit destinations, trusting the
// transaction author instead. The author is the adversary. lib.rs says so out
// loud: "reward to caller (the poster — manifest routes to worker)".
//
// Why the existing suite is green anyway: every helper writes an HONEST manifest,
// so it proves honest manifests behave honestly. That is a tautology with respect
// to this threat. `test_cancel_after_claim_returns_bond_to_worker_and_reward_to_poster`
// asserts a destination its own helper supplies, not one the blueprint enforces.

/// Malicious twin of the honest `cancel_task_by_poster_after_claim` helper.
/// Identical to it up to the escrow call; the ONLY difference is that it omits
/// the `bond → worker` leg and sweeps the entire worktop — reward, insurance,
/// AND the worker's claim bond — into the poster's own account.
///
/// ⚠️ **This manifest is NOT byte-identical to the pre-PULL version, and it
/// cannot be.** D-P1 changed the receipt from a `Bucket` to a `Proof`, so the
/// old manifest no longer type-checks against the blueprint at all. Left
/// unchanged it failed with `BlueprintPayloadValidationError: Expected =
/// Own<IsProof>, actual node: NonFungibleBucket` — which is a *calling
/// convention* error, not a security result. A tripwire that goes red because
/// the attacker used the wrong argument type proves nothing about whether the
/// attack works; it is the exact "verification that cannot fail" shape this
/// suite has been bitten by repeatedly.
///
/// So the convention is updated and **the hostile part is untouched**: no
/// `bond → worker` leg, and `deposit_batch(EntireWorktop)` into the attacker's
/// own account. That is the property under test, and it is preserved
/// character-for-character. The assertion in the test below — that the poster
/// nets zero — is therefore a statement about the blueprint, not about SBOR.
fn cancel_after_claim_keeping_the_bond(f: &mut Fixture, task_id: u64) -> TransactionReceipt {
    let receipt_nf_id = NonFungibleLocalId::integer(task_id);
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .create_proof_from_account_of_non_fungibles(
            f.poster_account,
            f.task_receipt_resource,
            indexset![receipt_nf_id],
        )
        .pop_from_auth_zone("receipt")
        .call_method_with_name_lookup(
            f.escrow,
            "cancel_task_by_poster_after_claim",
            |lookup| (task_id, lookup.proof("receipt")),
        )
        // No `take_all_from_worktop(XRD) → worker.try_deposit_or_abort` leg.
        // That leg is the ONLY thing that ever returned the bond, and it lived
        // in the manifest, so the poster simply declines to write it.
        .call_method(
            f.poster_account,
            "deposit_batch",
            manifest_args!(ManifestExpression::EntireWorktop),
        )
        .build();
    f.ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&f.poster_pk)],
    )
}

/// M4 — the poster cancels after claim and keeps the worker's bond.
///
/// Contrast with `test_cancel_after_claim_returns_bond_to_worker_and_reward_to_poster`:
/// same blueprint call, same state transition, opposite money outcome. The only
/// variable is who wrote the manifest. That is the finding.
#[test]
fn test_adversarial_poster_can_keep_the_workers_bond_on_cancel_after_claim() {
    let mut f = setup();
    let token = f.reward_token;
    add_token_to_whitelist(&mut f, token, dec!("10"));
    create_task(&mut f, dec!("100"), dec!("10"), dec!("0.1")).expect_commit_success();
    claim_task(&mut f, 1).expect_commit_success();

    let worker_before = f.ledger.get_component_balance(f.worker_account, f.reward_token);
    let poster_before = f.ledger.get_component_balance(f.poster_account, f.reward_token);

    cancel_after_claim_keeping_the_bond(&mut f, 1).expect_commit_success();

    let worker_after = f.ledger.get_component_balance(f.worker_account, f.reward_token);
    let poster_after = f.ledger.get_component_balance(f.poster_account, f.reward_token);

    // ── INVERTED BY PULL PHASE 2 ────────────────────────────────────────────
    // Fees come from the faucet, so these deltas are exactly the bond movement.
    // The attack manifest above is UNCHANGED. It no longer works, because there
    // is nothing on the worktop for it to steal.
    assert_eq!(
        poster_after - poster_before,
        dec!("0"),
        "M4 FIXED: the hostile manifest receives NO bond — the method returns no buckets"
    );
    assert_eq!(
        worker_after - worker_before,
        dec!("0"),
        "the worker is not paid at settlement either — under pull they are CREDITED, then collect"
    );

    assert_eq!(fetch_task(&mut f, 1).state, TaskState::Refunded);

    // The bond is now an entitlement the poster's manifest cannot touch.
    //
    // TWO LANES, asserted separately and never summed. They were different
    // RESOURCES when this was written (XRD bond / token reward); stage 5a made
    // them one resource, which makes the discipline MORE load-bearing, not
    // less — a credit routed to the wrong lane is now invisible to any check
    // that sums them, so the per-lane asserts below are the only thing that
    // sees it. Do not "simplify" these into a 111 total.
    let (worker_ent, poster_ent) = fetch_entitlements(&mut f, 1);
    let (worker_bond_ent, poster_bond_ent) = fetch_bond_entitlements(&mut f, 1);
    assert_eq!(worker_ent, dec!("0"), "no reward is owed to the worker on a cancel");
    assert_eq!(
        poster_ent,
        dec!("110"),
        "the poster is owed reward + insurance, and only that"
    );
    assert_eq!(worker_bond_ent, dec!("1"), "the worker is owed their bond back");
    assert_eq!(poster_bond_ent, dec!("0"), "the poster is owed no bond here");

    // Conservation, per lane, against what the vaults actually HOLD — not just
    // against each other. Entitlements agreeing with entitlements proves the
    // bookkeeping is self-consistent; only the vault balance proves it is
    // backed.
    let (reward_held, bond_held) = fetch_settlement_balances(&mut f, 1);
    assert_eq!(
        worker_ent + poster_ent,
        reward_held,
        "reward lane must conserve exactly — 100 reward + 10 insurance"
    );
    assert_eq!(reward_held, dec!("110"), "and be the full escrowed amount");
    assert_eq!(
        worker_bond_ent + poster_bond_ent,
        bond_held,
        "bond lane must conserve exactly"
    );
    assert_eq!(bond_held, dec!("1"), "and be the full claim bond");

    // And the worker can actually collect it, which is the half that would make
    // "no longer stolen" worthless if it failed.
    withdraw_worker(&mut f, 1).expect_commit_success();
    assert_eq!(
        f.ledger.get_component_balance(f.worker_account, f.reward_token) - worker_before,
        dec!("1"),
        "the worker collects their own bond"
    );
    // Assert the lane that actually MOVED. The reward-lane figure was already
    // zero before this withdrawal, so asserting it here would pass even if the
    // withdrawal had moved nothing — a check that cannot fail.
    assert_eq!(
        fetch_bond_entitlements(&mut f, 1).0,
        dec!("0"),
        "the bond entitlement is zeroed by the withdrawal"
    );
    assert_eq!(
        fetch_settlement_balances(&mut f, 1).1,
        dec!("0"),
        "and the bond lane vault is drained with it"
    );

    // Replay: the guarantee moved from "the token is spent" to "the state field
    // says so", so the second withdrawal must fail on the state field alone.
    withdraw_worker(&mut f, 1).expect_commit_failure();
}

/// BUG-7 — the worker delivers, the task Releases, and the worker is paid nothing.
///
/// This one uses the suite's OWN `approve_and_release` helper completely unchanged,
/// because that helper already deposits the entire worktop to `poster_account` and
/// has no worker leg at all. Nothing here is contrived: this is the release path
/// exactly as the existing green tests exercise it. The reason no test caught it is
/// that no test on the release path ever asserted the worker's balance — the only
/// worker-payment assertions in this file are in the DISPUTE tests, which route
/// through the blueprint's own split logic instead of the caller's manifest.
#[test]
fn test_adversarial_poster_can_keep_the_reward_after_the_worker_delivered() {
    let mut f = setup();
    let token = f.reward_token;
    add_token_to_whitelist(&mut f, token, dec!("10"));
    full_submit(&mut f, dec!("100"), dec!("10"), dec!("0.1"));

    let worker_before = f.ledger.get_component_balance(f.worker_account, f.reward_token);
    let poster_before = f.ledger.get_component_balance(f.poster_account, f.reward_token);

    approve_and_release(&mut f, 1).expect_commit_success();

    assert_eq!(fetch_task(&mut f, 1).state, TaskState::Released);

    let worker_after = f.ledger.get_component_balance(f.worker_account, f.reward_token);
    let poster_after = f.ledger.get_component_balance(f.poster_account, f.reward_token);

    // ── INVERTED BY PULL PHASE 2 ────────────────────────────────────────────
    // The helper is still the suite's OWN approve_and_release, still sweeping
    // the entire worktop to poster_account with no worker leg. That sweep was
    // the bug. It now sweeps nothing.
    assert_eq!(
        poster_after - poster_before,
        dec!("0"),
        "BUG-7 FIXED: the release manifest sweeps an EMPTY worktop — no reward, no insurance"
    );
    assert_eq!(
        worker_after - worker_before,
        dec!("0"),
        "nobody is paid at settlement under pull — the worker is credited, then collects"
    );

    let (worker_ent, poster_ent) = fetch_entitlements(&mut f, 1);
    assert_eq!(worker_ent, dec!("100"), "the worker is owed the full reward");
    assert_eq!(poster_ent, dec!("10"), "the poster is owed the insurance back");

    // ⚠️ WAS "legitimately EMPTY" — and that emptiness was the bearer hole.
    // submit_task handed the bond back to whoever CALLED it (the claim receipt
    // is a transferable bearer instrument), so a stolen receipt took the real
    // worker's bond. Since 5b the bond is HELD to settlement: approve credits
    // it to the pinned worker, and the happy path is where an honest worker
    // gets it back.
    let (worker_bond_ent, poster_bond_ent) = fetch_bond_entitlements(&mut f, 1);
    assert_eq!(worker_bond_ent, dec!("1"), "the bond is credited at settlement, to the worker");
    assert_eq!(poster_bond_ent, dec!("0"), "no claim expired on this task");

    let (reward_held, bond_held) = fetch_settlement_balances(&mut f, 1);
    assert_eq!(
        worker_ent + poster_ent,
        reward_held,
        "reward lane must conserve value exactly"
    );
    assert_eq!(reward_held, dec!("110"));
    assert_eq!(bond_held, dec!("1"), "the bond lane vault holds the bond until collected");

    // The worker collects what the poster's manifest used to take.
    withdraw_worker(&mut f, 1).expect_commit_success();
    assert_eq!(
        f.ledger.get_component_balance(f.worker_account, f.reward_token) - worker_before,
        dec!("101"),
        "the worker is paid the reward they earned, plus their bond back"
    );

    // Poster still collects their insurance — using a receipt that
    // approve_and_release deliberately no longer burns.
    withdraw_poster(&mut f, 1).expect_commit_success();
    assert_eq!(
        f.ledger.get_component_balance(f.poster_account, f.reward_token) - poster_before,
        dec!("10"),
        "the poster gets the insurance back, and only the insurance"
    );

    // Replay guard on both legs.
    withdraw_worker(&mut f, 1).expect_commit_failure();
    withdraw_poster(&mut f, 1).expect_commit_failure();
}

/// `instantiate` takes exactly the arguments on the signed sheet, in order,
/// with the signed types — no count in this sentence on purpose; the
/// SIGNED_ARGS list below IS the count. A source scrape, not a ledger test —
/// it runs in microseconds and, per CLAUDE.md, locally on a Mac where ledger
/// tests cannot run at all.
///
/// It exists because the deploy manifest is positional and write-once. Every
/// argument here is an economic parameter frozen for the life of the component,
/// and the failure mode is not a red test — it is a correctly-compiling manifest
/// that instantiates the wrong economics on mainnet, discovered later, fixable
/// only by a migration. DB-3 (sitting 2026-08-06) took this list from 13 to 11
/// by removing `heartbeat_fee_xrd` and `heartbeat_extension_secs`.
///
/// ⚠️ **The first version of this parser was line-oriented and had two silent
/// holes, found by adversarial review before merge.** It did `.lines().skip(1)`,
/// so a parameter written on the `pub fn instantiate(` line itself was invisible;
/// and it took one name per line, so `a: A, b: B, c: C` on one line yielded only
/// `a`. Either layout restored the heartbeat args and this test still PASSED —
/// and nothing enforces one-param-per-line, because there is no `cargo fmt
/// --check` in `.github/workflows/scrypto.yml`. Both are closed below by slicing
/// from after the open paren and splitting on commas rather than newlines. The
/// lesson generalises: a scrape that assumes a formatting convention the repo
/// does not enforce is a test of the formatter, not of the code.
///
/// P1-4 generates the deploy manifest from `docs/ESCROW-PARAMETER-SHEET.md`
/// §"PULL cutover" and diffs it before any signature. This is the same contract
/// asserted from the other end: that the SOURCE still matches the sheet the
/// generator reads. Both must agree for the deploy to be right, and neither
/// alone proves it.
#[test]
fn test_instantiate_signature_matches_the_signed_sheet() {
    const SRC: &str = include_str!("../src/lib.rs");

    // ⚠️ REPOINTED at Wave B (stage 5). This pinned rows 1-11 of
    // ESCROW-PARAMETER-SHEET.md §"PULL cutover" — the DEPLOYED component's
    // signature. It now pins §"Wave B", because that is the signature the next
    // instantiate manifest must match and the one being built. The PULL-cutover
    // signature is not lost: it is the component running on mainnet today and
    // is recorded in its own sheet section.
    //
    // Rows of ESCROW-PARAMETER-SHEET.md §"Wave B", in sheet order.
    //
    // Mutation-proven 2026-08-09, four ways, all RED: a param added on the
    // opening-paren line (A); three params on one line (B); two params reordered
    // (D — the change no compiler can see, and the one this test is really for);
    // a plain extra arg (E). ⚠️ The type column is pinned but is NOT independently
    // proven: the cheap type mutation (`claim_bond_xrd: u64`) is caught by rustc
    // first (E0308), so this test never gets to speak. It earns its place only for
    // a type change made coherently enough to compile — which does change the SBOR
    // arg shape the deploy manifest must match. Stated rather than claimed,
    // because overclaiming what a guard proves is what review caught in the
    // FIRST version of this very test.
    const SIGNED_ARGS: [(&str, &str); 15] = [
        ("worker_badge_resource", "ResourceAddress"),
        ("arbiter_badge_resource", "ResourceAddress"),
        ("agent_badge_resource", "Option<ResourceAddress>"),
        ("max_arbiter_fee_pct", "Decimal"),
        ("human_submit_deadline_secs", "u64"),
        ("agent_submit_deadline_secs", "u64"),
        ("dispute_auto_resolve_secs", "u64"),
        ("expire_grace_secs", "u64"),
        ("dispute_auto_resolve_default", "AutoResolveDefault"),
        ("min_insurance_fraction", "Decimal"),
        ("claim_bond_pct", "Decimal"),
        ("claim_bond_floor", "Decimal"),
        ("claim_bond_cap", "Decimal"),
        ("expire_bounty_pct", "Decimal"),
        ("review_window_secs", "u64"),
    ];

    const HEAD: &str = "pub fn instantiate(";
    let start = SRC.find(HEAD).expect("blueprint must declare `pub fn instantiate(`");
    let open = start + HEAD.len();
    let end = open
        + SRC[open..]
            .find(") -> ")
            .expect("unterminated instantiate parameter list");
    let params = &SRC[open..end];

    // Strip `//`-to-end-of-line comments, then flatten. Newlines carry no meaning
    // after this point — that is the whole fix.
    let flattened: String = params
        .lines()
        .map(|l| l.split("//").next().unwrap_or(""))
        .collect::<Vec<_>>()
        .join(" ");

    // Block comments would need real lexing. Refuse rather than guess: silently
    // mis-parsing is how the previous version passed while wrong.
    assert!(
        !flattened.contains("/*"),
        "instantiate's parameter list contains a block comment; this scraper does \
         not lex those. Use `//` comments here, or teach the scraper."
    );

    // Split on commas, keep only segments that declare a param (`name: Type`).
    // Segments without a colon are generic-argument continuations (e.g. the tail
    // of `Foo<A, B>`) and are skipped rather than turned into bogus names.
    let found: Vec<(String, String)> = flattened
        .split(',')
        .map(str::trim)
        .filter(|seg| seg.contains(':'))
        .map(|seg| {
            let (name, ty) = seg.split_once(':').unwrap();
            (
                name.trim().to_string(),
                ty.split_whitespace().collect::<String>(),
            )
        })
        .collect();

    // Guard against a VACUOUS pass, same as the event scrape below: if the parser
    // breaks, `found` goes empty and an empty-vs-empty comparison would report
    // success forever.
    assert!(
        !found.is_empty(),
        "instantiate scrape found NO parameters — the PARSER is broken, not the \
         blueprint. Fix the scrape before trusting this test again."
    );

    let expected: Vec<(String, String)> = SIGNED_ARGS
        .iter()
        .map(|(n, t)| (n.to_string(), t.to_string()))
        .collect();

    assert_eq!(
        found, expected,
        "`instantiate`'s parameters no longer match the signed sheet \
         (ESCROW-PARAMETER-SHEET.md §\"Wave B\"). These are write-once economics \
         set positionally at deploy: a changed arity, order or type here means \
         the P1-4 generated manifest and the blueprint disagree, and the \
         component is wrong for its whole life. Re-open the sheet before changing this."
    );
}

/// Every owner-gated `set_*` method must have a matching row in the Wave B
/// `instantiate` — 14 args table of the signed parameter sheet marked
/// settable, and every sheet row marked settable must have a matching
/// setter. This is a source scrape, not a ledger test, and it runs in
/// microseconds.
///
/// It closes the gap `test_instantiate_signature_matches_the_signed_sheet`
/// left open: that test only ever gated `instantiate`'s write-once
/// arguments. There was no gate at all for the setter surface Wave B added,
/// and that gap is exactly how a live drift happened — stage 1 (`2d73e03`)
/// shipped `set_expire_grace_secs` while the sheet still read "CARRIED /
/// unchanged" for that row, and nothing caught it until a peer session read
/// both files side by side and hand-fixed the sheet (`2cecf94`).
///
/// ⚠️ Does NOT prove: that a setter's VALIDATION matches `instantiate`'s
/// validation for the same field (only that the setter EXISTS); that a
/// sheet row's stated value or type is correct; anything about a setter
/// documented only in prose outside this one table. And the name-matching
/// rule below — a settable row named `foo` must have a `set_foo` method —
/// is a naming CONVENTION this test enforces, not a fact the compiler
/// checks: a single setter that legitimately covers two sheet rows under
/// one name (`set_submit_deadlines`, below, covers both
/// `human_submit_deadline_secs` and `agent_submit_deadline_secs`) fails
/// this gate by design, because a reader following the sheet alone has no
/// way to know that method exists. Undisclosed naming is itself a form of
/// the drift this test exists to catch.
#[test]
fn test_setters_match_the_signed_sheet() {
    const SRC: &str = include_str!("../src/lib.rs");
    // The signed sheet is a private-only input: publish/MANIFEST.md keeps
    // docs/ESCROW-PARAMETER-SHEET.md out of the public snapshot. Read it at run
    // time so this crate still compiles and tests in the public tree, where the
    // gate skips with a reason; GUILD_REQUIRE_PRIVATE_INPUTS=1 (the private CI's
    // strict switch) turns a missing sheet into a failure instead of a skip.
    let sheet_path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../docs/ESCROW-PARAMETER-SHEET.md");
    let sheet_owned = match std::fs::read_to_string(sheet_path) {
        Ok(text) => text,
        Err(_) if std::env::var("GUILD_REQUIRE_PRIVATE_INPUTS").ok().as_deref() != Some("1") => {
            eprintln!("skipped: {sheet_path} is not shipped in this tree (private-only input)");
            return;
        }
        Err(e) => panic!("GUILD_REQUIRE_PRIVATE_INPUTS=1 but {sheet_path} is unreadable: {e}"),
    };
    let sheet: &str = &sheet_owned;

    // ── Side A: every `set_*` method actually in the blueprint ──────────────
    let mut found_setters: Vec<String> = Vec::new();
    for line in SRC.lines() {
        let t = line.trim_start();
        if let Some(rest) = t.strip_prefix("pub fn set_") {
            let name: String = rest
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_')
                .collect();
            if !name.is_empty() {
                found_setters.push(format!("set_{name}"));
            }
        }
    }
    found_setters.sort();
    found_setters.dedup();

    // Guard against a VACUOUS pass, same shape as the two scrapes above: if
    // the parser breaks, `found_setters` goes empty and an empty-vs-empty
    // comparison would report success forever.
    assert!(
        found_setters.len() >= 3,
        "setter scrape found only {} `pub fn set_*` methods — the PARSER is \
         broken, not the blueprint. Fix the scrape before trusting this test again.",
        found_setters.len()
    );

    // ── Side B: every row marked settable in the Wave B instantiate table ───
    // (docs/ESCROW-PARAMETER-SHEET.md).
    //
    // ⚠️ Match a STABLE prefix, never the arg count. This was
    // "### `instantiate` — 14 args"; stage 5 took the signature to 14-going-on-15
    // and the heading changed, so this `find` stopped locating the table — the
    // gate could no longer see the thing it gates. A count in a matched string
    // is the same expiry-dated fact as a line number in a comment.
    const HEAD: &str = "### `instantiate` —";
    let start = sheet
        .find(HEAD)
        .expect("Wave B section must carry an `instantiate` table (heading prefix \"### `instantiate` —\")");
    let after_head = start + HEAD.len();
    let end = after_head
        + sheet[after_head..]
            .find("\n### ")
            .expect("`instantiate` table must be followed by another `### ` section");
    let table = &sheet[after_head..end];

    // A data row, after trimming, starts with `|` and its first cell parses
    // as a plain row number — that excludes the header row (`| # | Arg | …`)
    // and the `|---|---|…` separator without hand-picking line numbers.
    fn row_cells(row: &str) -> Option<Vec<&str>> {
        let t = row.trim();
        let inner = t.strip_prefix('|')?.strip_suffix('|')?;
        let parts: Vec<&str> = inner.split('|').map(str::trim).collect();
        parts.first()?.parse::<u32>().ok()?;
        Some(parts)
    }

    // `~~old~~ → new` rows (renames) name the CURRENT arg after the arrow;
    // everything else (backticks, bold, strikethrough) is markdown noise.
    fn clean_arg_name(raw: &str) -> String {
        let no_strike = raw.replace("~~", "");
        let current = no_strike.rsplit('→').next().unwrap_or(&no_strike);
        current
            .chars()
            .filter(|c| c.is_alphanumeric() || *c == '_')
            .collect()
    }

    let mut row_count = 0usize;
    let mut sheet_settable: Vec<String> = Vec::new();
    for line in table.lines() {
        let Some(c) = row_cells(line) else { continue };
        row_count += 1;
        // columns: [0]=#, [1]=Arg, [2]=Wave B value, [3]=Status, [4]=Ruling
        let status = c.get(3).copied().unwrap_or("");
        let lower = status.to_lowercase();
        if !lower.contains("settable") && !lower.contains("set via") {
            continue;
        }
        // A row may name its setter EXPLICITLY as ``set via `name` `` when one
        // setter legitimately covers several args — `claim_bond_params` moves
        // pct/floor/cap together because `cap >= floor` is a cross-field
        // invariant, and splitting it would permit a transient invalid state.
        // Without this, the only way to disclose such a setter was a fake extra
        // row in the ARGS table, which is wrong data modelling (a setter is not
        // an instantiate argument) and which the row-number parse silently
        // DROPPED, because "13a" is not a u32. A row the scraper skips in
        // silence is a vacuous pass waiting to happen.
        let arg_raw = c.get(1).copied().unwrap_or("");
        let name = match status.split_once("set via `") {
            Some((_, rest)) => rest
                .split('`')
                .next()
                .unwrap_or("")
                .trim()
                .to_string(),
            None => clean_arg_name(arg_raw),
        };
        assert!(
            !name.is_empty(),
            "row `{}` is marked settable but its Arg cell scraped to an empty \
             name — fix the scrape before trusting this test again",
            line.trim()
        );
        sheet_settable.push(format!("set_{name}"));
    }
    sheet_settable.sort();
    sheet_settable.dedup();

    // Guard against a VACUOUS pass, same shape as the two scrapes above: if
    // either parser breaks, its output goes empty (or the status filter
    // matches nothing) and an empty-vs-empty comparison would report success
    // forever.
    assert!(
        row_count >= 10,
        "instantiate-table scrape found only {row_count} rows — the PARSER is \
         broken, not the sheet. Fix the scrape before trusting this test again."
    );
    assert!(
        !sheet_settable.is_empty(),
        "found zero rows marked settable in the `instantiate` — 14 args table \
         — the STATUS-cell scrape is broken, not the sheet (Wave B carries \
         several settable rows as of the 2026-08-29 sittings)."
    );

    // ── The gate itself: the two sets must match, exactly, both ways ────────
    let setters_with_no_sheet_row: Vec<&String> = found_setters
        .iter()
        .filter(|s| !sheet_settable.contains(s))
        .collect();
    let sheet_rows_with_no_setter: Vec<&String> = sheet_settable
        .iter()
        .filter(|s| !found_setters.contains(s))
        .collect();

    assert!(
        setters_with_no_sheet_row.is_empty(),
        "these `set_*` methods exist in lib.rs but have NO matching settable \
         row (by the `set_<arg>` naming convention) in the Wave B \
         `instantiate` — 14 args table: {setters_with_no_sheet_row:?}. A \
         setter the sheet doesn't disclose is exactly the asymmetry the \
         sheet exists to prevent — either the sheet is missing a row, or the \
         method name doesn't match the arg it sets."
    );
    assert!(
        sheet_rows_with_no_setter.is_empty(),
        "these sheet rows are marked settable but have NO matching \
         `set_<arg>` method in lib.rs: {sheet_rows_with_no_setter:?}. This \
         is the live drift class this test exists to close — either the \
         setter hasn't shipped yet and the row should say so (not \
         `settable`), or it shipped under a different name than its arg (one \
         setter can legitimately cover more than one row, as \
         `set_submit_deadlines` does for `human_submit_deadline_secs` and \
         `agent_submit_deadline_secs`) and the sheet should name it \
         explicitly rather than leave a reader to guess."
    );
}

/// Every `ScryptoEvent` struct must appear in the blueprint's `#[events(...)]`
/// list. This is a source scrape, not a ledger test, and it runs in microseconds.
///
/// It exists because an unregistered event is invisible to everything cheap.
/// `cargo check` passes. `cargo build --target wasm32` passes. Any test that
/// never reaches the emitting line passes. It surfaces only as a runtime
/// `BlueprintPayloadDoesNotExist` — on the money path, at settlement.
///
/// That is precisely how PULL phase 1 shipped "48 tests green": it added
/// `SettlementCreditedEvent` and `WithdrawalEvent`, emitted neither, and the
/// omission stayed invisible until phase 2 started emitting them, costing a full
/// ~15-minute CI cycle with 11 tests red for one missing line. Registration is a
/// mechanical property, so it gets a mechanical check rather than a comment
/// asking the next person to remember.
#[test]
fn test_every_partial_take_is_rounded_to_the_tokens_divisibility() {
    // 🔴 A CLASS GUARD, not an instance guard — and it exists because the
    // instance guard was not enough.
    //
    // The 6dp rounding was fixed once, in `credit_split_for_parties` and
    // `required_bond` and the expire bounty, and the suite went green. It was
    // still missing on `resolve_dispute`'s arbiter fee, because that is a
    // FOURTH percentage multiplication feeding a FOURTH `Vault::take`, and
    // nothing connected the four. Fixing three of four sites and testing three
    // of four is exactly how this recurs, so this test asserts the property
    // over ALL of them at once.
    //
    // The rule: a partial `.take(x)` must be preceded by a `checked_round`.
    // `take_all()` is always safe (a vault's own balance is representable by
    // construction) and is exempt. This runs from source in microseconds, needs
    // no ledger, and therefore runs on this Mac — see CLAUDE.md on why that
    // matters here.
    const SRC: &str = include_str!("../src/lib.rs");
    let lines: Vec<&str> = SRC.lines().collect();

    // Sites that take a value which is ALREADY representable, with the reason.
    // Matched on a stable nearby string rather than a line number, because a
    // line number in this file rots on the next insertion above it.
    //
    // - the two settlement-vault withdrawals take a stored entitlement, and
    //   every path that CREDITS an entitlement rounded before crediting it, so
    //   the stored value cannot carry places the token lacks.
    const EXEMPT_BY_PRECEDING_MARKER: [&str; 2] = [
        "settlement vault missing",
        "bond settlement vault missing",
    ];

    let mut partial_takes = 0usize;
    let mut unrounded: Vec<(usize, String)> = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        if !line.contains(".take(") || line.contains(".take_all(") {
            continue;
        }
        partial_takes += 1;
        let lo = i.saturating_sub(12);
        let window = lines[lo..i].join("\n");
        let rounded = window.contains("checked_round");
        let exempt = EXEMPT_BY_PRECEDING_MARKER
            .iter()
            .any(|m| window.contains(m));
        if !rounded && !exempt {
            unrounded.push((i + 1, line.trim().to_string()));
        }
    }

    // Guard against a VACUOUS pass, same discipline as the events test below:
    // if the scrape ever stops matching, `partial_takes` goes to zero and this
    // test reports success forever while checking nothing.
    assert!(
        partial_takes >= 4,
        "found only {partial_takes} partial `.take(` sites — the SCRAPE is broken, not the \
         blueprint. Fix the scrape before trusting this test again."
    );

    assert!(
        unrounded.is_empty(),
        "these `.take(` sites are not preceded by a `checked_round`. On an 18dp token that is \
         harmless; on the 6dp stablecoins rewards are moving to, `Vault::take` PANICS on an \
         unrepresentable amount and the whole settlement path reverts — permanently, because \
         the inputs do not change between retries. Round ToZero to the token's divisibility \
         first, or add an entry to EXEMPT_BY_PRECEDING_MARKER with the reason it is already \
         representable: {unrounded:?}"
    );
}

#[test]
fn test_every_scrypto_event_is_registered_in_the_events_attribute() {
    const SRC: &str = include_str!("../src/lib.rs");
    let lines: Vec<&str> = SRC.lines().collect();

    // Declared: a `ScryptoEvent` derive, then the `pub struct <Name>` under it.
    let mut declared: Vec<String> = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        if !line.contains("ScryptoEvent") {
            continue;
        }
        for next in lines.iter().skip(i + 1).take(4) {
            if let Some(rest) = next.trim().strip_prefix("pub struct ") {
                let name: String = rest
                    .chars()
                    .take_while(|c| c.is_alphanumeric() || *c == '_')
                    .collect();
                if !name.is_empty() {
                    declared.push(name);
                }
                break;
            }
        }
    }

    let start = SRC
        .find("#[events(")
        .expect("blueprint must carry an #[events(...)] attribute");
    let end = start
        + SRC[start..]
            .find(")]")
            .expect("unterminated #[events(...)] attribute");
    let registered = &SRC[start..end];

    // Guard against a VACUOUS pass. If the scrape ever stops matching, `declared`
    // goes empty, the filter below has nothing to reject, and this test silently
    // becomes decoration that reports success forever. Same failure mode the
    // route-classification test was given a floor for (#299); same fix.
    assert!(
        declared.len() >= 15,
        "event scrape found only {} ScryptoEvent structs — the PARSER is broken, \
         not the blueprint. Fix the scrape before trusting this test again.",
        declared.len()
    );

    let missing: Vec<&String> = declared
        .iter()
        .filter(|name| !registered.contains(name.as_str()))
        .collect();
    assert!(
        missing.is_empty(),
        "these ScryptoEvent structs are declared but NOT registered in #[events(...)]. \
         Emitting any of them panics at runtime with BlueprintPayloadDoesNotExist, and \
         nothing short of a ledger test that reaches the emit will tell you: {:?}",
        missing
    );
}

// ── Local verification: what works and what does not (re-measured 2026-08-01) ──
//
// `cargo check --lib` DOES work on macOS, ~1-2s incremental. The older note here
// said local checking was impossible; that is wrong and it cost real time, since
// every signature error in this change was catchable locally.
//
// `cargo test` does NOT work, and it fails in two stages — clearing the first
// does not get you past the second, which is the trap:
//   1. Host-side, the harness's `cxx` dep dies on `__builtin_clzg` because
//      MacOSX.sdk symlinks to MacOSX26.5.sdk (libc++ wants clang 19+) while
//      xcode-select gives Apple clang 16. `SDKROOT=.../MacOSX15.sdk` genuinely
//      fixes THIS, and afterwards all 48 tests are collected and attempted —
//      which looks like success and is not.
//   2. Every one then fails identically, because scrypto-test's ledger simulator
//      compiles this package to wasm32-unknown-unknown and blst will not build
//      for that target here. "0 passed; 48 failed" is ONE failure before any
//      test body runs.
//
// So CI (.github/workflows/scrypto.yml, ubuntu) remains the only place these
// assertions are ever actually evaluated. Batch changes; expect ~15-min cycles.

// ── PAYEE PIN — the bearer claim, and the tests that can observe it ──────────
//
// Read this before adding to the section. Under pull, an entitlement sits on
// chain until collected, gated on a credential. BOTH credentials are freely
// transferable and permanently un-retrofittable: the Guild Member badge by
// design (`withdrawer=AllowAll`, `withdrawer_updater=DenyAll`, and public-mint
// besides), and the task receipt by OMISSION — `task_receipt_manager` never
// calls `withdraw_roles!`, so it inherits exactly the same SDK default. So
// "whoever holds it at withdrawal time collects" applied to both sides.
//
// The fix separates AUTHORIZATION from PAYEE: the credential still decides who
// may trigger a withdrawal, and an account pinned at create_task/claim_task
// decides where the money lands.
//
// ⚠️ WHY THESE TESTS HAD TO BE WRITTEN, rather than an existing one adjusted.
// Changing `withdraw_*` to return nothing broke ZERO existing tests, and that is
// a warning rather than a convenience: both withdraw helpers end in
// `deposit_batch(EntireWorktop)` into the payee's OWN account, so with an empty
// worktop the batch is a harmless no-op and every call site keeps passing. The
// suite was structurally incapable of observing who got paid. Each test below
// therefore asserts on BALANCES of a party that is not the caller — the only
// shape that can catch a redirect — and never on commit status alone.

/// Move worker badge #1 out of the worker's account. This is the whole attack:
/// no exploit, no sophistication, just a transfer of a transferable NFT.
fn steal_worker_badge(f: &mut Fixture, thief: ComponentAddress) {
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .withdraw_non_fungibles_from_account(
            f.worker_account,
            f.worker_badge,
            indexset![NonFungibleLocalId::integer(1)],
        )
        .try_deposit_entire_worktop_or_abort(thief, None)
        .build();
    f.ledger
        .execute_manifest(
            manifest,
            vec![NonFungibleGlobalId::from_public_key(&f.worker_pk)],
        )
        .expect_commit_success();
}

#[test]
fn test_stolen_worker_badge_cannot_redirect_the_payout() {
    let mut f = setup();
    let token = f.reward_token;
    add_token_to_whitelist(&mut f, token, dec!("10"));
    create_task(&mut f, dec!("100"), dec!("10"), dec!("0.1")).expect_commit_success();
    claim_task(&mut f, 1).expect_commit_success();
    submit_task(&mut f, 1, 1).expect_commit_success();
    approve_and_release(&mut f, 1).expect_commit_success();

    // The worker is owed the reward and has not collected it — the exact state
    // that used to be a bearer claim.
    assert_eq!(fetch_entitlements(&mut f, 1).0, dec!("100"));

    let (thief_pk, _, thief_account) = f.ledger.new_allocated_account();
    steal_worker_badge(&mut f, thief_account);

    let worker_before = f.ledger.get_component_balance(f.worker_account, f.reward_token);
    let thief_before = f.ledger.get_component_balance(thief_account, f.reward_token);

    // The thief holds the badge, so they pass the auth check — deliberately.
    // They also route the worktop to themselves. Under the old design that was
    // sufficient; the funds never reach the worktop now.
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .create_proof_from_account_of_non_fungibles(
            thief_account,
            f.worker_badge,
            indexset![NonFungibleLocalId::integer(1)],
        )
        .pop_from_auth_zone("stolen")
        .call_method_with_name_lookup(f.escrow, "withdraw_worker", |lookup| {
            (1u64, lookup.proof("stolen"))
        })
        .try_deposit_entire_worktop_or_abort(thief_account, None)
        .build();
    let receipt = f.ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&thief_pk)],
    );

    // It SUCCEEDS. That is the design: the badge authorizes, it does not own.
    // Asserting a revert here would be the wrong test — it would pass just as
    // well against a blueprint that rejected every withdrawal for any reason.
    receipt.expect_commit_success();

    assert_eq!(
        f.ledger.get_component_balance(thief_account, f.reward_token) - thief_before,
        dec!("0"),
        "PAYEE PIN: the badge thief collects NOTHING, having paid the fee to move \
         someone else's money to them"
    );
    assert_eq!(
        f.ledger.get_component_balance(f.worker_account, f.reward_token) - worker_before,
        dec!("101"),
        "the funds — reward AND held bond — land in the account pinned at \
         claim_task, the worker who did the work"
    );
    assert_eq!(
        fetch_entitlements(&mut f, 1).0,
        dec!("0"),
        "and the entitlement is spent, so this is delivery, not a duplicate"
    );
}

#[test]
fn test_stolen_task_receipt_cannot_redirect_the_payout() {
    let mut f = setup();
    let token = f.reward_token;
    add_token_to_whitelist(&mut f, token, dec!("10"));
    create_task(&mut f, dec!("100"), dec!("10"), dec!("0.1")).expect_commit_success();
    claim_task(&mut f, 1).expect_commit_success();
    submit_task(&mut f, 1, 1).expect_commit_success();
    approve_and_release(&mut f, 1).expect_commit_success();

    // The poster is owed the insurance back and has not collected it.
    assert_eq!(fetch_entitlements(&mut f, 1).1, dec!("10"));

    let (thief_pk, _, thief_account) = f.ledger.new_allocated_account();

    // The task receipt is transferable for the same reason the badge is — here
    // by omission rather than by design. Steal it.
    let steal = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .withdraw_non_fungibles_from_account(
            f.poster_account,
            f.task_receipt_resource,
            indexset![NonFungibleLocalId::integer(1)],
        )
        .try_deposit_entire_worktop_or_abort(thief_account, None)
        .build();
    f.ledger
        .execute_manifest(
            steal,
            vec![NonFungibleGlobalId::from_public_key(&f.poster_pk)],
        )
        .expect_commit_success();

    let poster_before = f.ledger.get_component_balance(f.poster_account, f.reward_token);
    let thief_before = f.ledger.get_component_balance(thief_account, f.reward_token);

    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .create_proof_from_account_of_non_fungibles(
            thief_account,
            f.task_receipt_resource,
            indexset![NonFungibleLocalId::integer(1)],
        )
        .pop_from_auth_zone("stolen")
        .call_method_with_name_lookup(f.escrow, "withdraw_poster", |lookup| {
            (1u64, lookup.proof("stolen"))
        })
        .try_deposit_entire_worktop_or_abort(thief_account, None)
        .build();
    f.ledger
        .execute_manifest(
            manifest,
            vec![NonFungibleGlobalId::from_public_key(&thief_pk)],
        )
        .expect_commit_success();

    assert_eq!(
        f.ledger.get_component_balance(thief_account, f.reward_token) - thief_before,
        dec!("0"),
        "PAYEE PIN: the receipt thief collects NOTHING"
    );
    assert_eq!(
        f.ledger.get_component_balance(f.poster_account, f.reward_token) - poster_before,
        dec!("10"),
        "the insurance lands in the account pinned at create_task"
    );
}

#[test]
fn test_create_task_rejects_non_account_poster() {
    let mut f = setup();
    let token = f.reward_token;
    add_token_to_whitelist(&mut f, token, dec!("10"));

    // The escrow component itself: a real, live global address that is NOT an
    // account. Without the entity-type assert this would be accepted, the task
    // would fund, `assert_conservation` would hold, and `withdraw_poster` would
    // panic forever with the money already escrowed. Failing here puts the error
    // in the designator's own transaction, while they can still fix it.
    let not_an_account = f.escrow;
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .withdraw_from_account(f.poster_account, f.reward_token, dec!("110"))
        .take_from_worktop(f.reward_token, dec!("100"), "reward")
        .take_from_worktop(f.reward_token, dec!("10"), "insurance")
        .call_method_with_name_lookup(f.escrow, "create_task", |lookup| {
            (
                not_an_account,
                lookup.bucket("reward"),
                lookup.bucket("insurance"),
                dec!("0.1"),
                Hash([0u8; 32]),
            )
        })
        .try_deposit_entire_worktop_or_abort(f.poster_account, None)
        .build();
    let receipt = f.ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&f.poster_pk)],
    );

    assert!(
        receipt.is_commit_failure(),
        "a non-account poster must be refused at pin time"
    );
    let err = format!("{:?}", receipt.expect_commit_failure());
    assert!(
        err.contains("poster must be a global account address"),
        "must fail on the payee-pin assert specifically, not incidentally: {}",
        err
    );
}

#[test]
fn test_claim_task_rejects_non_account_worker() {
    let mut f = setup();
    let token = f.reward_token;
    add_token_to_whitelist(&mut f, token, dec!("10"));
    create_task(&mut f, dec!("100"), dec!("10"), dec!("0.1")).expect_commit_success();

    let not_an_account = f.escrow;
    let bond = f.claim_bond;
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .create_proof_from_account_of_non_fungibles(
            f.worker_account,
            f.worker_badge,
            vec![NonFungibleLocalId::integer(1)],
        )
        .pop_from_auth_zone("worker_proof")
        .withdraw_from_account(f.worker_account, f.reward_token, bond)
        .take_from_worktop(f.reward_token, bond, "bond")
        .call_method_with_name_lookup(f.escrow, "claim_task", |lookup| {
            (
                1u64,
                not_an_account,
                lookup.proof("worker_proof"),
                lookup.bucket("bond"),
            )
        })
        .try_deposit_entire_worktop_or_abort(f.worker_account, None)
        .build();
    let receipt = f.ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&f.worker_pk)],
    );

    assert!(
        receipt.is_commit_failure(),
        "a non-account worker must be refused at pin time"
    );
    let err = format!("{:?}", receipt.expect_commit_failure());
    assert!(
        err.contains("worker must be a global account address"),
        "must fail on the payee-pin assert specifically: {}",
        err
    );
}

// ═════════════════════════════════════════════════════════════════════════════
// Component royalties — the Shape-B revenue dial (DB-2, sitting 2026-08-06).
// What these prove: the dial exists ONLY on create_task, only the royalty-admin
// badge can move it, the worker legs are locked Free at the ENGINE level (not
// by our code), and only the owner can collect. What they do NOT prove: custody
// separation of the two badges — that is a deploy-manifest property (the
// fixture deposits both into owner_account), enforced by the P1-4 sheet gate.
// ═════════════════════════════════════════════════════════════════════════════

fn royalty_admin_proof_manifest(f: &Fixture) -> ManifestBuilder {
    ManifestBuilder::new().lock_fee_from_faucet().call_method(
        f.owner_account,
        "create_proof_of_amount",
        manifest_args!(f.royalty_admin_badge, dec!("1")),
    )
}

fn set_create_task_royalty(f: &mut Fixture, proof: Option<&str>, amount: RoyaltyAmount) -> TransactionReceipt {
    // proof: "admin" | "owner" | None — which badge proof precedes the set call.
    let builder = match proof {
        Some("admin") => royalty_admin_proof_manifest(f),
        Some("owner") => owner_proof_manifest(f),
        _ => ManifestBuilder::new().lock_fee_from_faucet(),
    };
    let manifest = builder
        .set_component_royalty(f.escrow, "create_task", amount)
        .build();
    f.ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&f.owner_pk)],
    )
}

#[test]
fn test_royalty_launch_state_charges_zero_on_create() {
    let mut f = setup();
    let reward_token = f.reward_token;
    add_token_to_whitelist(&mut f, reward_token, dec!("0"));
    let receipt = create_task(&mut f, dec!("100"), dec!("5"), dec!("0"));
    receipt.expect_commit_success();
    assert_eq!(
        receipt.fee_summary.total_royalty_cost_in_xrd,
        dec!("0"),
        "the dial ships at 0 — a fresh component must charge no royalty"
    );
}

#[test]
fn test_royalty_dial_set_by_admin_then_charged_on_create() {
    let mut f = setup();
    let reward_token = f.reward_token;
    add_token_to_whitelist(&mut f, reward_token, dec!("0"));
    set_create_task_royalty(&mut f, Some("admin"), RoyaltyAmount::Xrd(dec!("1")))
        .expect_commit_success();
    let receipt = create_task(&mut f, dec!("100"), dec!("5"), dec!("0"));
    receipt.expect_commit_success();
    assert_eq!(
        receipt.fee_summary.total_royalty_cost_in_xrd,
        dec!("1"),
        "a dialed royalty must actually charge on create_task"
    );
}

#[test]
fn test_royalty_dial_without_any_proof_fails() {
    let mut f = setup();
    let receipt = set_create_task_royalty(&mut f, None, RoyaltyAmount::Xrd(dec!("1")));
    receipt.expect_commit_failure_containing_error("Unauthorized");
}

#[test]
fn test_royalty_dial_refuses_the_owner_badge() {
    // The separation is real in BOTH directions: owner cannot move the dial…
    let mut f = setup();
    let receipt = set_create_task_royalty(&mut f, Some("owner"), RoyaltyAmount::Xrd(dec!("1")));
    receipt.expect_commit_failure_containing_error("Unauthorized");
}

#[test]
fn test_worker_legs_are_locked_even_for_the_admin() {
    // The load-bearing trust rows: engine-level KeyValueEntryLocked, so
    // "workers pay 0, forever" holds against the admin badge itself.
    let mut f = setup();
    for method in ["claim_task", "submit_task", "withdraw_worker"] {
        let manifest = royalty_admin_proof_manifest(&f)
            .set_component_royalty(f.escrow, method, RoyaltyAmount::Xrd(dec!("1")))
            .build();
        let receipt = f.ledger.execute_manifest(
            manifest,
            vec![NonFungibleGlobalId::from_public_key(&f.owner_pk)],
        );
        receipt.expect_commit_failure_containing_error("KeyValueEntryLocked");
    }
}

#[test]
fn test_royalty_above_protocol_max_is_rejected() {
    // MAX_PER_FUNCTION_ROYALTY_IN_XRD = 166.666… (10 protocol-USD); 200 must
    // fail even with the right badge — the ceiling is the ledger's, not ours.
    let mut f = setup();
    let receipt = set_create_task_royalty(&mut f, Some("admin"), RoyaltyAmount::Xrd(dec!("200")));
    receipt.expect_commit_failure_containing_error("RoyaltyAmountIsGreaterThanAllowed");
}

#[test]
fn test_royalty_claim_is_owner_only_and_sweeps_the_accumulator() {
    let mut f = setup();
    let reward_token = f.reward_token;
    add_token_to_whitelist(&mut f, reward_token, dec!("0"));
    set_create_task_royalty(&mut f, Some("admin"), RoyaltyAmount::Xrd(dec!("1")))
        .expect_commit_success();
    create_task(&mut f, dec!("100"), dec!("5"), dec!("0")).expect_commit_success();

    // The admin badge must NOT be able to collect (separation, direction two)…
    let manifest = royalty_admin_proof_manifest(&f)
        .claim_component_royalties(f.escrow)
        .try_deposit_entire_worktop_or_abort(f.owner_account, None)
        .build();
    let receipt = f.ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&f.owner_pk)],
    );
    receipt.expect_commit_failure_containing_error("Unauthorized");

    // …and the owner collects exactly the accrued 1 XRD. Balance-assert on the
    // recipient, not the caller's own view of success.
    let before = f.ledger.get_component_balance(f.owner_account, XRD);
    let manifest = owner_proof_manifest(&f)
        .claim_component_royalties(f.escrow)
        .try_deposit_entire_worktop_or_abort(f.owner_account, None)
        .build();
    let receipt = f.ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&f.owner_pk)],
    );
    receipt.expect_commit_success();
    let after = f.ledger.get_component_balance(f.owner_account, XRD);
    assert_eq!(
        after - before,
        dec!("1"),
        "the owner must receive exactly the accrued royalty"
    );
}

#[test]
fn test_every_method_has_a_royalty_row_and_only_create_task_is_updatable() {
    // Source-scrape invariant (runs on the Mac, no ledger). Exhaustiveness of
    // the init block is already COMPILER-enforced (component_royalties! expands
    // to a struct literal — a missing row is E0063; measured 2026-08-09). What
    // the compiler does NOT enforce, and this test does: create_task is the
    // ONLY `updatable` entry, and every other row — the worker legs above all —
    // says `locked`. A future edit flipping a row to `updatable` compiles
    // clean and hands the setter a dial on that leg; this test is what reddens.
    // (Mutation-proven: claim_task→updatable fails the assert below.)
    const SRC: &str = include_str!("../src/lib.rs");

    // Line-local patterns, no block slicing (nested braces make slicing lie):
    // an auth entry is the ONLY line shape ending "=> PUBLIC;" or containing
    // "restrict_to:"; a royalty row is the ONLY line shape ending ", locked;"
    // or ", updatable;". Both are macro-exclusive syntax in this file.
    fn leading_name(line: &str) -> Option<String> {
        let t = line.trim();
        let idx = t.find(" => ")?;
        let name = &t[..idx];
        if !name.is_empty() && name.chars().all(|c| c.is_alphanumeric() || c == '_') {
            Some(name.to_string())
        } else {
            None
        }
    }

    let mut methods: Vec<String> = Vec::new();
    for line in SRC.lines() {
        if (line.contains("=> PUBLIC;") || line.contains("restrict_to:")) && !line.trim_start().starts_with("//") {
            if let Some(name) = leading_name(line) {
                methods.push(name);
            }
        }
    }
    assert!(
        methods.len() >= 20,
        "method scrape looks broken — found only {}: {:?}",
        methods.len(),
        methods
    );

    let royalty_rows: Vec<&str> = SRC
        .lines()
        .filter(|l| {
            let t = l.trim();
            !t.starts_with("//") && (t.ends_with(", locked;") || t.ends_with(", updatable;")) && t.contains(" => ")
        })
        .collect();

    let mut updatable: Vec<String> = Vec::new();
    for m in &methods {
        let row = royalty_rows
            .iter()
            .find(|l| l.trim().starts_with(&format!("{} =>", m)))
            .unwrap_or_else(|| panic!("method `{}` has NO royalty row — an absent entry is settable later; add `{} => Free, locked;`", m, m));
        if row.contains("updatable") {
            updatable.push(m.clone());
        } else {
            assert!(
                row.contains("Free") && row.contains("locked"),
                "method `{}` must be `Free, locked` (row: `{}`)",
                m,
                row.trim()
            );
        }
    }
    assert_eq!(
        updatable,
        vec!["create_task".to_string()],
        "exactly ONE updatable royalty row is allowed, and it is create_task — the poster-side dial"
    );
    // The three worker legs stated explicitly, so a refactor that renames or
    // splits them cannot silently drop the on-ledger promise.
    for leg in ["claim_task", "submit_task", "withdraw_worker"] {
        assert!(
            methods.contains(&leg.to_string()),
            "worker leg `{}` vanished from enable_method_auth — re-verify the on-ledger 0% promise",
            leg
        );
    }
}


// ── 6-decimal reward token: the stablecoin case ──────────────────────────────
//
// The guild is moving task rewards from XRD (18dp) to a USD stablecoin. Every
// viable candidate is 6dp. These tests cover what that changes, and they are
// the ONLY tests in this file that do — see setup_full_div's note.

/// A stablecoin-shaped fixture: SplitEvenly default, default bond, 6dp reward.
fn setup_6dp() -> Fixture {
    setup_full_div(AutoResolveDefault::SplitEvenly, CLAIM_BOND, 6)
}

#[test]
fn test_split_on_a_6dp_token_rounds_down_and_conserves() {
    // 🔴 THE TEST THE ROUNDING FIX EXISTS FOR.
    //
    // `worker_share` multiplies an amount by a percentage. On an 18dp token any
    // product is representable and `Bucket::take` always succeeds. On a 6dp
    // token it is not: `take` with an amount carrying more decimal places than
    // the resource can express PANICS — and it would panic HERE, on the dispute
    // settlement path, i.e. exactly when two parties are already in conflict
    // over the money. A dispute that cannot be resolved is the worst state this
    // component can reach.
    //
    // The ruling below is chosen to produce a deliberately unrepresentable
    // product rather than a tidy one:
    //   arbiter_fee        = 10 * 0.1                    = 1
    //   remaining insurance                              = 9
    //   worker_reward      = 100 * 0.333333333333333333  = 33.3333333333333333
    //   worker_insurance   = 9   * 0.333333333333333333  = 2.999999999999999997
    //   worker_total_raw                                 = 36.333333333333333297
    // 36.333333333333333297 needs 18 decimal places; the token has 6. Without
    // the ToZero round in credit_split_for_parties this transaction reverts.
    // The BOND leg (W5, 5b) hits the same wall with the same pct:
    //   worker_bond_raw    = 1 * 0.333333333333333333    — 18 places, 6 allowed
    // so this test now covers BOTH checked_round calls in that helper.
    //
    // FALSIFIER, stated plainly: delete EITHER `checked_round` call in
    // credit_split_for_parties and this test fails — not on an assertion, but
    // on `expect_commit_success`, because the transaction panics.
    let mut f = setup_6dp();
    let token = f.reward_token;
    add_token_to_whitelist(&mut f, token, dec!("10"));
    full_submit(&mut f, dec!("100"), dec!("10"), dec!("0.1"));
    raise_dispute_as_poster(&mut f, 1, None).expect_commit_success();

    let worker_before = f.ledger.get_component_balance(f.worker_account, f.reward_token);
    let poster_before = f.ledger.get_component_balance(f.poster_account, f.reward_token);

    resolve_dispute_helper(
        &mut f,
        1,
        DisputeRuling::Split {
            worker_pct: dec!("0.333333333333333333"),
            poster_pct: dec!("0.666666666666666667"),
        },
    )
    .expect_commit_success();

    // Truncated to the token's 6 decimals, never rounded to nearest: the shaved
    // remainder must land in the poster's share, which is the property the file
    // already documents ("the poster's share is the REMAINDER, never a
    // separately-computed product").
    let (worker_entitled, poster_entitled) = fetch_entitlements(&mut f, 1);
    assert_eq!(
        worker_entitled,
        dec!("36.333333"),
        "worker's share must be truncated to the token's divisibility, not rounded to nearest"
    );
    assert_eq!(
        poster_entitled,
        dec!("72.666667"),
        "the truncated dust must land in the poster's remainder"
    );

    // The bond leg truncates the same way, remainder to the poster.
    let (worker_bond, poster_bond) = fetch_bond_entitlements(&mut f, 1);
    assert_eq!(worker_bond, dec!("0.333333"), "bond share truncated to 6dp");
    assert_eq!(poster_bond, dec!("0.666667"), "bond dust lands in the poster's remainder");

    // CONSERVATION — the property that actually matters. Each lane's
    // entitlements must sum to exactly what went in (100 reward + 9 insurance
    // after the arbiter's 1; the full 1 bond), with nothing created and
    // nothing stranded in either vault.
    assert_eq!(
        worker_entitled + poster_entitled,
        dec!("109"),
        "rounding must not create or destroy value"
    );
    assert_eq!(
        worker_bond + poster_bond,
        dec!("1"),
        "the bond lane conserves through its own truncation too"
    );
    assert_eq!(
        fetch_settlement_balances(&mut f, 1),
        (dec!("109"), dec!("1")),
        "each lane's halves backed by that lane's vault holding exactly their sum"
    );

    // And both sides can actually COLLECT it — a rounded entitlement nobody can
    // withdraw would be the same bug one step later.
    withdraw_worker(&mut f, 1).expect_commit_success();
    withdraw_poster(&mut f, 1).expect_commit_success();
    assert_eq!(
        f.ledger.get_component_balance(f.worker_account, f.reward_token) - worker_before,
        dec!("36.666666")
    );
    assert_eq!(
        f.ledger.get_component_balance(f.poster_account, f.reward_token) - poster_before,
        dec!("73.333334")
    );
    assert_eq!(fetch_settlement_balances(&mut f, 1), (dec!("0"), dec!("0")));
}

#[test]
fn test_arbiter_fee_on_a_6dp_token_rounds_down_and_conserves() {
    // 🔴 THE SECOND ROUNDING SITE — the one the first fix missed.
    //
    // `test_split_on_a_6dp_token_rounds_down_and_conserves` above covers
    // `credit_split_for_parties`. It cannot cover THIS leg, because it passes
    // `fee_pct = 0.1` against insurance 10, and 10 * 0.1 = 1 is representable at
    // any divisibility. So the arbiter fee — a second, separate `Vault::take`
    // fed by a second, separate percentage multiplication — sat unrounded and
    // untested while the suite went green on the rounding it does cover.
    //
    // `arbiter_fee_pct` is a free 18dp `Decimal`. `create_task` bounds it to
    // [0, max_arbiter_fee_pct] and imposes NO granularity constraint, so the
    // product routinely carries more places than the token can express:
    //   arbiter_fee_raw = 10 * 0.333333333333333333 = 3.33333333333333333
    // Seventeen decimal places against a token that has six.
    //
    // The ruling is `PayWorker` deliberately, not `Split`: it makes every OTHER
    // leg exactly representable, so the only thing in this transaction that can
    // panic is the arbiter fee itself. That isolation is the point — a `Split`
    // here would still pass if someone deleted the arbiter-fee round and left
    // the split one, because the split round would mask it.
    //
    // FALSIFIER, stated plainly: delete the `checked_round` on `arbiter_fee` in
    // `resolve_dispute` and this test fails on `expect_commit_success`, not on
    // an assertion — the transaction panics inside `Vault::take`. And because
    // `arbiter_fee_pct` is pinned per task and the vault balance does not move
    // while Disputed, every retry panics identically: the task's human-arbiter
    // path would be permanently dead, leaving only `auto_resolve_dispute`.
    let mut f = setup_6dp();
    let token = f.reward_token;
    add_token_to_whitelist(&mut f, token, dec!("10"));
    full_submit(&mut f, dec!("100"), dec!("10"), dec!("0.333333333333333333"));
    raise_dispute_as_poster(&mut f, 1, None).expect_commit_success();

    let worker_before = f.ledger.get_component_balance(f.worker_account, f.reward_token);
    let arbiter_before = f.ledger.get_component_balance(f.arbiter_account, f.reward_token);

    resolve_dispute_helper(&mut f, 1, DisputeRuling::PayWorker).expect_commit_success();

    // Truncated to the token's 6 decimals, never rounded to nearest.
    assert_eq!(
        f.ledger.get_component_balance(f.arbiter_account, f.reward_token) - arbiter_before,
        dec!("3.333333"),
        "the arbiter's fee must be truncated to the token's divisibility"
    );

    // The shaved dust must stay in the insurance vault and flow into
    // `remaining_insurance` — i.e. it lands with a party, exactly as the
    // truncation in the split path does. 10 - 3.333333 = 6.666667.
    let (worker_entitled, poster_entitled) = fetch_entitlements(&mut f, 1);
    assert_eq!(
        worker_entitled,
        dec!("106.666667"),
        "PayWorker gives the worker the reward plus the remaining insurance, dust included"
    );
    assert_eq!(poster_entitled, Decimal::ZERO, "PayWorker leaves the poster nothing");

    // CONSERVATION across the arbiter's cut — the property that actually
    // matters. Nothing created, nothing stranded, and in particular the dust is
    // accounted for rather than left behind in the insurance vault.
    assert_eq!(
        worker_entitled + poster_entitled + dec!("3.333333"),
        dec!("110"),
        "reward + insurance must come out exactly, fee included"
    );

    // And it must be collectable — a rounded entitlement nobody can withdraw
    // would be the same bug one step later.
    withdraw_worker(&mut f, 1).expect_commit_success();
    assert_eq!(
        f.ledger.get_component_balance(f.worker_account, f.reward_token) - worker_before,
        dec!("106.666667") + Decimal::from_str(CLAIM_BOND).unwrap(),
        "worker collects their entitlement plus the returned bond"
    );
}

#[test]
fn test_auto_resolve_split_evenly_on_a_6dp_token() {
    // The DEPLOYED default path, on the token rewards are moving to. An odd
    // total makes the even split unrepresentable at 6dp only if it needs more
    // than 6 places — 109/2 = 54.5 does not, so this test's value is NOT the
    // arithmetic but the coverage: auto_resolve_dispute is PUBLIC, permissionless
    // and is the path both real mainnet disputes have taken, and until now it
    // had never run against a non-18dp token at all.
    let mut f = setup_6dp();
    let token = f.reward_token;
    add_token_to_whitelist(&mut f, token, dec!("10"));
    full_submit(&mut f, dec!("100"), dec!("10"), dec!("0.1"));
    raise_dispute_as_poster(&mut f, 1, None).expect_commit_success();

    advance_time_by_secs(&mut f.ledger, 1_209_601);
    auto_resolve_dispute(&mut f, 1).expect_commit_success();

    let (worker_entitled, poster_entitled) = fetch_entitlements(&mut f, 1);
    assert_eq!(
        worker_entitled + poster_entitled,
        dec!("110"),
        "auto-resolve conserves on a 6dp token: insurance returns whole to the poster"
    );
    // W5: the bond splits 50/50 with the reward ruling — 0.5 is representable
    // at 6dp, so the value here is coverage, same as the reward leg above.
    assert_eq!(fetch_bond_entitlements(&mut f, 1), (dec!("0.5"), dec!("0.5")));
    assert_eq!(fetch_settlement_balances(&mut f, 1).1, dec!("1"));
}

#[test]
fn test_expire_bounty_truncates_at_6dp_and_the_house_keeps_the_dust() {
    // The bounty leg's own rounding, on the token that needs it. A 0.999999
    // bond at the 0.1 fixture pct yields a raw bounty of 0.0999999 — seven
    // places on a six-place token. `Bucket::take` with that amount PANICS, so
    // without the ToZero round in expire_claim this public, permissionless
    // method would revert on exactly the tokens rewards are moving to.
    //
    // FALSIFIER: delete the `checked_round` on the bounty in expire_claim and
    // this fails on `expect_commit_success`, not on an assertion.
    let mut f = setup_full_div(AutoResolveDefault::SplitEvenly, "0.999999", 6);
    let token = f.reward_token; add_token_to_whitelist(&mut f, token, dec!("10"));
    create_task(&mut f, dec!("100"), dec!("10"), dec!("0.1")).expect_commit_success();
    claim_task(&mut f, 1).expect_commit_success();

    advance_past_expire_grace(&mut f.ledger);
    let caller_before = f.ledger.get_component_balance(f.arbiter_account, f.reward_token);
    expire_claim(&mut f, 1).expect_commit_success();

    let caller_delta =
        f.ledger.get_component_balance(f.arbiter_account, f.reward_token) - caller_before;
    assert_eq!(
        caller_delta,
        dec!("0.099999"),
        "bounty truncated DOWN to the token's six places"
    );
    assert_eq!(
        fetch_forfeited(&mut f),
        dec!("0.9"),
        "the shaved dust lands in the house remainder, never minted or stranded"
    );
    assert_eq!(
        caller_delta + fetch_forfeited(&mut f),
        dec!("0.999999"),
        "the two legs sum to exactly the forfeited bond"
    );
}

#[test]
fn test_zero_divisibility_reward_token_is_rejected_at_whitelist() {
    // The degenerate case the whitelist guard exists for. At divisibility 0 a
    // 50/50 split of a 1-unit reward pays the worker nothing, so the token is
    // rejected at the door rather than discovered mid-dispute.
    //
    // ⚠️ Note what is deliberately NOT asserted: that 6dp is rejected. An
    // earlier draft of the guard rejected everything below 18dp, which would
    // have rejected every stablecoin the guild could actually use — a guard
    // that bans its entire candidate set. This test pins the guard at the
    // degenerate case only, so that mistake cannot come back quietly.
    let mut f = setup();
    let zero_div = f
        .ledger
        .create_fungible_resource(dec!("1000"), 0, f.poster_account);
    let manifest = owner_proof_manifest(&f)
        .call_method(
            f.escrow,
            "add_accepted_token",
            manifest_args!(zero_div, dec!("1")),
        )
        .build();
    let receipt = f.ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&f.owner_pk)],
    );
    receipt.expect_commit_failure();
}


#[test]
fn test_no_bare_line_citations_in_lib_rs_comments() {
    // A line number in a comment is a fact with an expiry date.
    //
    // This is not a style rule — it is the third instance of one failure shape
    // found in a single day, and the only one of the three that had ALREADY
    // been diagnosed in writing and recurred anyway. The comment at the
    // self-claim assert records its own reference being "wrong twice —
    // :711 -> :727 -> :935" and concludes exactly the sentence above. That
    // lesson lived in one comment instead of a gate, so the two-lane invariant
    // block kept its own stale citations, and BOTH of those were wrong before
    // anyone noticed: on origin/main the cited line held `task_receipt_manager`.
    //
    // Cite code by CONTENT, which grep finds and which cannot rot. Where a
    // citation is genuinely warranted — quoting this anti-pattern, or pointing
    // at another crate pinned by version — mark it `[cite-exempt: <reason>]`.
    // The marker is deliberately verbose: an exemption should cost a sentence.
    const SRC: &str = include_str!("../src/lib.rs");

    let mut offenders: Vec<String> = Vec::new();
    let mut exempt = 0usize;
    for (i, line) in SRC.lines().enumerate() {
        let Some(comment) = line.split_once("//").map(|(_, c)| c) else { continue };
        // A citation is a colon immediately followed by 2+ digits.
        let has_citation = comment.as_bytes().windows(3).any(|w| {
            w[0] == b':' && w[1].is_ascii_digit() && w[2].is_ascii_digit()
        });
        if !has_citation {
            continue;
        }
        if comment.contains("[cite-exempt:") {
            exempt += 1;
            continue;
        }
        offenders.push(format!("  lib.rs:{} {}", i + 1, line.trim()));
    }

    // Guard against a VACUOUS pass, same shape as the other scrapes here: if
    // the detector broke, it would find nothing and report success forever.
    // The exempt sites are the positive control — they PROVE the detector still
    // fires, because each one contains the pattern and is only skipped by the
    // marker.
    assert!(
        exempt >= 3,
        "the citation detector found only {exempt} exempt sites — it is the \
         DETECTOR that is broken, not the file. Fix the scrape before trusting \
         this test again."
    );

    assert!(
        offenders.is_empty(),
        "these comments cite code by LINE NUMBER, which rots on the next \
         insertion above them:\n{}\n\nCite by content instead (a symbol name, \
         an assert's text) so grep can find it. If the citation is genuinely \
         warranted, mark it `[cite-exempt: <reason>]`.",
        offenders.join("\n")
    );
}

#[test]
fn test_every_method_appears_in_the_auth_model_table() {
    // Closes the blind spot a parallel session found in the method-catalog
    // gate: that gate regenerates the signature table but says of itself that
    // "the Auth Model table and all prose are hand-maintained and NOT covered".
    // The uncovered half was wrong in a way green CI could never surface — all
    // seven owner-gated setters were missing, so a reader consulting the table
    // would have concluded the component has five owner methods when it has
    // twelve. A gate that is green over the part that is wrong is the same
    // failure shape as a stale line citation, one level up.
    const SRC: &str = include_str!("../src/lib.rs");
    const INVENTORY: &str = include_str!("../../../../docs/ESCROW-METHOD-INVENTORY.md");

    // Every method named in `enable_method_auth!`.
    let block = SRC
        .split_once("enable_method_auth!")
        .and_then(|(_, rest)| rest.split_once("\n    }"))
        .map(|(b, _)| b)
        .expect("could not locate the enable_method_auth! block");
    let declared: Vec<&str> = block
        .lines()
        .filter_map(|l| {
            let l = l.trim();
            if l.starts_with("//") {
                return None;
            }
            l.split_once("=>").map(|(name, _)| name.trim())
        })
        .filter(|n| !n.is_empty() && n.chars().all(|c| c.is_alphanumeric() || c == '_'))
        .collect();

    assert!(
        declared.len() >= 20,
        "scraped only {} methods from enable_method_auth! — the PARSER is \
         broken, not the file.",
        declared.len()
    );

    let auth_table = INVENTORY
        .split_once("### Auth Model")
        .map(|(_, rest)| rest)
        .expect("ESCROW-METHOD-INVENTORY.md has no `### Auth Model` section");

    let missing: Vec<&&str> = declared
        .iter()
        .filter(|m| !auth_table.contains(&format!("| {m} |")))
        .collect();

    assert!(
        missing.is_empty(),
        "these methods are auth-gated in lib.rs but absent from the Auth Model \
         table in docs/ESCROW-METHOD-INVENTORY.md: {missing:?}. That table is \
         hand-maintained and the catalog gate does NOT cover it, so nothing \
         else would have caught this."
    );
}


#[test]
fn test_auto_resolve_default_variant_order_is_pinned() {
    // Variant ORDER is an on-chain encoding, not a style choice: SBOR encodes
    // by index, so `SplitEvenly` is `Enum<1u8>` in every instantiate manifest
    // and in the signed parameter sheet. Reordering or INSERTING a variant
    // silently re-points every manifest that names one by index — including
    // ones already written into runbooks and already signed.
    //
    // The enum carries a comment saying "new variants go at the END, always".
    // Today's lesson is that a comment saying so is not a control. This is.
    const SRC: &str = include_str!("../src/lib.rs");
    let body = SRC
        .split_once("pub enum AutoResolveDefault {")
        .and_then(|(_, rest)| rest.split_once('}'))
        .map(|(b, _)| b)
        .expect("could not locate the AutoResolveDefault enum");

    let variants: Vec<&str> = body
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with("//") && !l.starts_with("///"))
        .map(|l| l.trim_end_matches(','))
        .filter(|l| !l.is_empty())
        .collect();

    assert_eq!(
        variants,
        vec![
            "FavorDisputeRaiser", // Enum<0u8>
            "SplitEvenly",        // Enum<1u8> — the deployed default
            "ReturnToPoster",     // Enum<2u8>
            "FavorNonRaiser",     // Enum<3u8> — Wave B W1, appended
        ],
        "AutoResolveDefault's variant order changed. These are SBOR indices \
         baked into signed manifests: SplitEvenly MUST stay at index 1. If you \
         are adding a variant, append it and extend this list; if you are \
         reordering, stop — every manifest naming a variant by index is now \
         wrong, silently."
    );
}


#[test]
fn test_auto_resolve_favor_non_raiser_pays_the_other_side() {
    // FavorNonRaiser is the exact mirror of FavorDisputeRaiser: whoever raised
    // LOSES. Ledger-level because the variant's whole value is which account
    // ends up with the money, and no source scrape can tell you that.
    //
    // ⚠️ This proves the MECHANISM, not that the variant is safe to select.
    // Selected alone it hands a stonewalling poster a free win — a worker whose
    // only escape is raising a dispute now loses by raising it. It is coherent
    // only with auto-release (W2) and submission validation (P4-3), which is
    // why the operator ruled all three together and why nothing selects this
    // before stage 6. A green test here is not a licence to deploy it.
    let mut f = setup_with_default(AutoResolveDefault::FavorNonRaiser);
    let token = f.reward_token;
    add_token_to_whitelist(&mut f, token, dec!("10"));
    full_submit(&mut f, dec!("100"), dec!("10"), dec!("0.1"));

    // The WORKER raises, so under FavorNonRaiser the POSTER should win.
    raise_dispute_as_worker(&mut f, 1, None).expect_commit_success();
    advance_time_by_secs(&mut f.ledger, 1_209_601);
    auto_resolve_dispute(&mut f, 1).expect_commit_success();

    let (worker_entitled, poster_entitled) = fetch_entitlements(&mut f, 1);
    assert_eq!(
        worker_entitled,
        dec!("0"),
        "the raiser (worker) must receive nothing under FavorNonRaiser"
    );
    assert_eq!(
        poster_entitled,
        dec!("110"),
        "the non-raiser (poster) takes reward + insurance whole"
    );
    assert_eq!(fetch_task(&mut f, 1).state, TaskState::Refunded);

    // FALSIFIER: swap the match arms in auto_resolve_dispute's FavorNonRaiser
    // branch and these two assertions invert. That is the whole point of the
    // variant, so it is the thing worth pinning.
}


// ── push_entitlement: the stranded-funds recovery path (Wave B stage 4) ──────

#[test]
fn test_push_entitlement_pays_the_pinned_worker_when_a_stranger_calls() {
    // The property the method exists for: a payee who never collects — or who
    // lost the badge that lets them — still gets paid, on anyone's call.
    let mut f = setup();
    let token = f.reward_token;
    add_token_to_whitelist(&mut f, token, dec!("10"));
    full_submit(&mut f, dec!("100"), dec!("10"), dec!("0.1"));
    approve_and_release(&mut f, 1).expect_commit_success();

    let worker_before = f.ledger.get_component_balance(f.worker_account, f.reward_token);
    let (worker_entitled, _) = fetch_entitlements(&mut f, 1);
    // Both lanes: push deposits reward AND bond (deposit_both_lanes), and
    // since 5b the happy path holds the bond to settlement, so it is here.
    let (worker_bond, _) = fetch_bond_entitlements(&mut f, 1);
    assert!(worker_entitled > Decimal::ZERO, "precondition: worker is owed");
    assert!(worker_bond > Decimal::ZERO, "precondition: the held bond is owed too");

    // Signed by the ARBITER account — a third party with no receipt, no worker
    // badge, and no relationship to this task's settlement.
    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .call_method(
            f.escrow,
            "push_entitlement",
            manifest_args!(1u64, EntitledParty::Worker),
        )
        .build();
    f.ledger
        .execute_manifest(
            manifest,
            vec![NonFungibleGlobalId::from_public_key(&f.arbiter_pk)],
        )
        .expect_commit_success();

    assert_eq!(
        f.ledger.get_component_balance(f.worker_account, f.reward_token) - worker_before,
        worker_entitled + worker_bond,
        "the pinned worker account received BOTH lanes, though a stranger paid the fee"
    );
    assert_eq!(fetch_entitlements(&mut f, 1).0, dec!("0"));
    assert_eq!(fetch_bond_entitlements(&mut f, 1).0, dec!("0"));
}

#[test]
fn test_push_entitlement_cannot_redirect_funds_to_the_caller() {
    // 🔴 THE SAFETY CLAIM, ASSERTED DIRECTLY. push_entitlement is PUBLIC and
    // takes no Proof, so the ONLY thing standing between it and the
    // caller-routed settlement that BUG-7 was is this: the destination comes
    // from state, and the method has no address parameter to abuse.
    //
    // A caller cannot pass a destination — there is no such argument — so what
    // this pins is that the money lands on the PIN and nowhere else, even when
    // the caller is an account that would love to receive it.
    let mut f = setup();
    let token = f.reward_token;
    add_token_to_whitelist(&mut f, token, dec!("10"));
    full_submit(&mut f, dec!("100"), dec!("10"), dec!("0.1"));
    approve_and_release(&mut f, 1).expect_commit_success();

    let attacker_before = f.ledger.get_component_balance(f.arbiter_account, f.reward_token);
    let worker_before = f.ledger.get_component_balance(f.worker_account, f.reward_token);

    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .call_method(
            f.escrow,
            "push_entitlement",
            manifest_args!(1u64, EntitledParty::Worker),
        )
        // Sweep anything the call might have returned into the caller's account.
        // Under a caller-routed design this is exactly how the money would be
        // taken; here the worktop must be empty.
        .call_method(
            f.arbiter_account,
            "deposit_batch",
            manifest_args!(ManifestExpression::EntireWorktop),
        )
        .build();
    f.ledger
        .execute_manifest(
            manifest,
            vec![NonFungibleGlobalId::from_public_key(&f.arbiter_pk)],
        )
        .expect_commit_success();

    assert_eq!(
        f.ledger.get_component_balance(f.arbiter_account, f.reward_token),
        attacker_before,
        "the caller must receive NOTHING — push deposits to the pin, it does not \
         return a bucket to whoever called it"
    );
    assert!(
        f.ledger.get_component_balance(f.worker_account, f.reward_token) > worker_before,
        "and the pinned worker must still have been paid"
    );
}

#[test]
fn test_push_entitlement_reverts_when_nothing_is_owed() {
    // The zero-value case reverts before any account is touched — which is why
    // L1 ruled no minimum floor is needed against dust-spam. The guard already
    // exists in deposit_both_lanes; this pins that push inherits it.
    let mut f = setup();
    let token = f.reward_token;
    add_token_to_whitelist(&mut f, token, dec!("10"));
    full_submit(&mut f, dec!("100"), dec!("10"), dec!("0.1"));
    approve_and_release(&mut f, 1).expect_commit_success();
    withdraw_worker(&mut f, 1).expect_commit_success();

    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .call_method(
            f.escrow,
            "push_entitlement",
            manifest_args!(1u64, EntitledParty::Worker),
        )
        .build();
    f.ledger
        .execute_manifest(
            manifest,
            vec![NonFungibleGlobalId::from_public_key(&f.arbiter_pk)],
        )
        .expect_commit_failure();
}


#[test]
fn test_dispute_terms_are_pinned_at_raise_and_a_later_setter_cannot_move_them() {
    // 🔴 The settlement-integrity property. auto_resolve_dispute used to read
    // BOTH the window and the default ruling live from config, so the owner
    // could change the outcome of a dispute already in flight — decide it after
    // the fact, from one signed transaction, with no counterparty consent.
    //
    // The product promise is "the deal both sides see is the deal that
    // settles". A config value read at settlement time is not that.
    //
    // FALSIFIER: revert auto_resolve_dispute to read self.* instead of the
    // task's pinned fields and this test fails — the owner's mid-dispute switch
    // to ReturnToPoster would take effect and the worker would receive 0.
    let mut f = setup_with_default(AutoResolveDefault::SplitEvenly);
    let token = f.reward_token;
    add_token_to_whitelist(&mut f, token, dec!("10"));
    full_submit(&mut f, dec!("100"), dec!("10"), dec!("0.1"));
    raise_dispute_as_worker(&mut f, 1, None).expect_commit_success();

    // The owner now tries to change the rules of a dispute already running:
    // flip the default so the poster takes everything, and shorten the window.
    let manifest = owner_proof_manifest(&f)
        .call_method(
            f.escrow,
            "set_dispute_auto_resolve_default",
            manifest_args!(AutoResolveDefault::ReturnToPoster),
        )
        .call_method(f.escrow, "set_dispute_auto_resolve_secs", manifest_args!(60u64))
        .build();
    f.ledger
        .execute_manifest(
            manifest,
            vec![NonFungibleGlobalId::from_public_key(&f.owner_pk)],
        )
        .expect_commit_success();

    // The shortened window must NOT apply: at 61s the pinned 14d has not run.
    advance_time_by_secs(&mut f.ledger, 61);
    auto_resolve_dispute(&mut f, 1).expect_commit_failure();

    // At the PINNED window it resolves — under the PINNED ruling, not the new one.
    advance_time_by_secs(&mut f.ledger, 1_209_601);
    auto_resolve_dispute(&mut f, 1).expect_commit_success();

    let (worker_entitled, poster_entitled) = fetch_entitlements(&mut f, 1);
    assert_eq!(
        worker_entitled,
        dec!("50"),
        "the ruling in force when the dispute was RAISED (SplitEvenly) must \
         govern — not the one the owner switched to afterwards"
    );
    assert_eq!(poster_entitled, dec!("60"), "50 of reward + 10 insurance home");
}


#[test]
fn test_submit_task_returns_nothing() {
    // 🔴 The bearer-credential regression, gated at source.
    //
    // `submit_task` used to end `-> Bucket` and hand the claim bond back to
    // whoever CALLED it, without ever reading `task.worker_account`. The claim
    // receipt is a transferable bearer instrument (`withdrawer=AllowAll`,
    // `withdrawer_updater=DenyAll` — permanent), so a stolen receipt let anyone
    // submit an arbitrary evidence hash and take the real worker's bond. The
    // receipt was both the authorisation and the payee.
    //
    // Wave B 5b removed the return entirely: the bond stays in its vault until
    // a settlement path credits it to a PINNED account. Submitting is no longer
    // a money-moving action.
    //
    // ⚠️ WHY THIS TEST AND NOT AN INVARIANT. A parallel session extended the
    // Quint model and MEASURED that `invConservation` does not catch this: the
    // sums balance across lanes regardless of who called, so an adversarial
    // submit still conserves. Conservation proves no value was created or
    // destroyed; it proves nothing about who received it. They had assumed it
    // would catch it and found otherwise — so this is a distinct check, not a
    // belt-and-braces duplicate.
    //
    // Cheap, source-level, and it fails the instant anyone re-adds a return
    // type — including a "temporary" one.
    const SRC: &str = include_str!("../src/lib.rs");
    let sig_start = SRC
        .find("pub fn submit_task(")
        .expect("submit_task not found — has it been renamed?");
    // The signature runs to the opening brace of the body.
    let body_start = SRC[sig_start..]
        .find('{')
        .expect("submit_task signature has no body");
    let signature = &SRC[sig_start..sig_start + body_start];

    assert!(
        !signature.contains("->"),
        "submit_task has a RETURN TYPE again:\n  {}\n\nIt must return nothing. \
         Returning a value from submit_task is how the claim bond was handed to \
         whoever held the (transferable) claim receipt rather than to the pinned \
         worker. If a settlement genuinely needs to move the bond, credit it to a \
         pinned account via credit_bond_entitlement — do not return it.",
        signature.trim()
    );

    // Vacuous-pass guard: prove the scrape actually found a signature, so a
    // rename cannot turn this into an empty check that passes forever.
    assert!(
        signature.contains("claim_receipt") && signature.contains("evidence_hash"),
        "the submit_task signature scrape did not find the expected parameters — \
         the PARSER is broken, not the blueprint. Fix the scrape before trusting \
         this test again. Got:\n  {}",
        signature.trim()
    );
}
