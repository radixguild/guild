use scrypto_test::prelude::*;

struct Fixture {
    ledger: DefaultLedgerSimulator,
    owner_pk: Secp256k1PublicKey,
    owner_account: ComponentAddress,
    controller: ComponentAddress,
    owner_badge: ResourceAddress,
    agent_badge: ResourceAddress,
}

fn setup() -> Fixture {
    let mut ledger = LedgerSimulatorBuilder::new().build();
    let (owner_pk, _, owner_account) = ledger.new_allocated_account();
    let package_address = ledger.compile_and_publish(this_package!());

    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .call_function(
            package_address,
            "AgentBadgeController",
            "instantiate",
            manifest_args!(),
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
    let controller = commit.new_component_addresses()[0];
    let resources = commit.new_resource_addresses();
    let owner_badge = resources[0];
    let agent_badge = resources[1];

    Fixture {
        ledger,
        owner_pk,
        owner_account,
        controller,
        owner_badge,
        agent_badge,
    }
}

fn mint_manifest(
    f: &Fixture,
    agent_account: ComponentAddress,
    agent_name: &str,
    radix_address: &str,
    spending_limit_per_task: Decimal,
    daily_spending_cap: Decimal,
) -> TransactionManifestV1 {
    ManifestBuilder::new()
        .lock_fee_from_faucet()
        .call_method(
            f.owner_account,
            "create_proof_of_amount",
            manifest_args!(f.owner_badge, dec!("1")),
        )
        .call_method(
            f.controller,
            "mint_agent_badge",
            manifest_args!(
                agent_name.to_string(),
                radix_address.to_string(),
                spending_limit_per_task,
                daily_spending_cap
            ),
        )
        // Third-party deposit: the agent account is not the tx signer, so the
        // owner-gated deposit_batch is Unauthorized — use the public try_* path
        // (same as the production mint manifest).
        .try_deposit_entire_worktop_or_abort(agent_account, None)
        .build()
}

fn find_badge_vault(
    f: &mut Fixture,
    account: ComponentAddress,
) -> Option<InternalAddress> {
    let vaults = f
        .ledger
        .get_component_vaults(account, f.agent_badge);
    vaults
        .into_iter()
        .next()
        .map(|node_id| InternalAddress::new_or_panic(node_id.0))
}

#[test]
fn test_instantiate_creates_component_and_owner_badge() {
    let mut f = setup();
    let owner_badge_balance = f.ledger.get_component_balance(f.owner_account, f.owner_badge);
    assert_eq!(owner_badge_balance, dec!("1"));
}

#[test]
fn test_mint_with_owner_proof_succeeds_and_deposits_to_agent() {
    let mut f = setup();
    let (_, _, agent_account) = f.ledger.new_allocated_account();

    let receipt = f.ledger.execute_manifest(
        mint_manifest(
            &f,
            agent_account,
            "alice_agent",
            "account_rdx12alicedummyaddress00000000000000000000",
            dec!("100"),
            dec!("500"),
        ),
        vec![NonFungibleGlobalId::from_public_key(&f.owner_pk)],
    );
    receipt.expect_commit_success();

    assert_eq!(
        f.ledger.get_component_balance(agent_account, f.agent_badge),
        dec!("1")
    );
}

#[test]
fn test_mint_without_owner_proof_fails() {
    let mut f = setup();
    let (other_pk, _, other_account) = f.ledger.new_allocated_account();

    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .call_method(
            f.controller,
            "mint_agent_badge",
            manifest_args!(
                "rogue".to_string(),
                "account_rdx12rogue00000000000000000000000000000000".to_string(),
                dec!("100"),
                dec!("500")
            ),
        )
        .call_method(
            other_account,
            "deposit_batch",
            manifest_args!(ManifestExpression::EntireWorktop),
        )
        .build();

    let receipt = f.ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&other_pk)],
    );
    receipt.expect_commit_failure();
}

#[test]
fn test_mint_rejects_empty_agent_name() {
    let mut f = setup();
    let (_, _, agent_account) = f.ledger.new_allocated_account();
    let receipt = f.ledger.execute_manifest(
        mint_manifest(
            &f,
            agent_account,
            "",
            "account_rdx12dummy0000000000000000000000000000000000",
            dec!("100"),
            dec!("500"),
        ),
        vec![NonFungibleGlobalId::from_public_key(&f.owner_pk)],
    );
    receipt.expect_commit_failure();
}

#[test]
fn test_mint_rejects_zero_spending_limit() {
    let mut f = setup();
    let (_, _, agent_account) = f.ledger.new_allocated_account();
    let receipt = f.ledger.execute_manifest(
        mint_manifest(
            &f,
            agent_account,
            "alice",
            "account_rdx12dummy0000000000000000000000000000000000",
            dec!("0"),
            dec!("500"),
        ),
        vec![NonFungibleGlobalId::from_public_key(&f.owner_pk)],
    );
    receipt.expect_commit_failure();
}

#[test]
fn test_mint_rejects_daily_cap_less_than_per_task() {
    let mut f = setup();
    let (_, _, agent_account) = f.ledger.new_allocated_account();
    let receipt = f.ledger.execute_manifest(
        mint_manifest(
            &f,
            agent_account,
            "alice",
            "account_rdx12dummy0000000000000000000000000000000000",
            dec!("500"),
            dec!("100"),
        ),
        vec![NonFungibleGlobalId::from_public_key(&f.owner_pk)],
    );
    receipt.expect_commit_failure();
}

#[test]
fn test_multiple_mints_get_distinct_ids() {
    let mut f = setup();
    let (_, _, a1) = f.ledger.new_allocated_account();
    let (_, _, a2) = f.ledger.new_allocated_account();

    for (acct, name) in [(a1, "alice"), (a2, "bob")] {
        let receipt = f.ledger.execute_manifest(
            mint_manifest(
                &f,
                acct,
                name,
                "account_rdx12dummy0000000000000000000000000000000000",
                dec!("100"),
                dec!("500"),
            ),
            vec![NonFungibleGlobalId::from_public_key(&f.owner_pk)],
        );
        receipt.expect_commit_success();
    }

    assert_eq!(f.ledger.get_component_balance(a1, f.agent_badge), dec!("1"));
    assert_eq!(f.ledger.get_component_balance(a2, f.agent_badge), dec!("1"));
}

#[test]
fn test_recall_drains_agent_vault() {
    let mut f = setup();
    let (_, _, agent_account) = f.ledger.new_allocated_account();

    f.ledger
        .execute_manifest(
            mint_manifest(
                &f,
                agent_account,
                "alice",
                "account_rdx12dummy0000000000000000000000000000000000",
                dec!("100"),
                dec!("500"),
            ),
            vec![NonFungibleGlobalId::from_public_key(&f.owner_pk)],
        )
        .expect_commit_success();
    assert_eq!(
        f.ledger.get_component_balance(agent_account, f.agent_badge),
        dec!("1")
    );

    let vault = find_badge_vault(&mut f, agent_account).expect("agent vault for badge");

    // Engine-level recall via manifest with owner badge proof in the auth zone,
    // then burn the recalled bucket so it can't be redeposited.
    let recall_manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .call_method(
            f.owner_account,
            "create_proof_of_amount",
            manifest_args!(f.owner_badge, dec!("1")),
        )
        .recall_non_fungibles(vault, [NonFungibleLocalId::integer(1)])
        .burn_all_from_worktop(f.agent_badge)
        .build();
    f.ledger
        .execute_manifest(
            recall_manifest,
            vec![NonFungibleGlobalId::from_public_key(&f.owner_pk)],
        )
        .expect_commit_success();

    assert_eq!(
        f.ledger.get_component_balance(agent_account, f.agent_badge),
        dec!("0")
    );
}

#[test]
fn test_recall_without_owner_proof_fails() {
    let mut f = setup();
    let (_, _, agent_account) = f.ledger.new_allocated_account();
    let (other_pk, _, _) = f.ledger.new_allocated_account();

    f.ledger
        .execute_manifest(
            mint_manifest(
                &f,
                agent_account,
                "alice",
                "account_rdx12dummy0000000000000000000000000000000000",
                dec!("100"),
                dec!("500"),
            ),
            vec![NonFungibleGlobalId::from_public_key(&f.owner_pk)],
        )
        .expect_commit_success();
    let vault = find_badge_vault(&mut f, agent_account).expect("agent vault");

    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .recall_non_fungibles(vault, [NonFungibleLocalId::integer(1)])
        .burn_all_from_worktop(f.agent_badge)
        .build();
    let receipt = f.ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&other_pk)],
    );
    receipt.expect_commit_failure();
    assert_eq!(
        f.ledger.get_component_balance(agent_account, f.agent_badge),
        dec!("1")
    );
}

#[test]
fn test_double_recall_fails() {
    let mut f = setup();
    let (_, _, agent_account) = f.ledger.new_allocated_account();

    f.ledger
        .execute_manifest(
            mint_manifest(
                &f,
                agent_account,
                "alice",
                "account_rdx12dummy0000000000000000000000000000000000",
                dec!("100"),
                dec!("500"),
            ),
            vec![NonFungibleGlobalId::from_public_key(&f.owner_pk)],
        )
        .expect_commit_success();
    let vault = find_badge_vault(&mut f, agent_account).expect("agent vault");

    let recall_builder = || {
        ManifestBuilder::new()
            .lock_fee_from_faucet()
            .call_method(
                f.owner_account,
                "create_proof_of_amount",
                manifest_args!(f.owner_badge, dec!("1")),
            )
            .recall_non_fungibles(vault, [NonFungibleLocalId::integer(1)])
            .burn_all_from_worktop(f.agent_badge)
            .build()
    };

    f.ledger
        .execute_manifest(
            recall_builder(),
            vec![NonFungibleGlobalId::from_public_key(&f.owner_pk)],
        )
        .expect_commit_success();
    let second = f.ledger.execute_manifest(
        recall_builder(),
        vec![NonFungibleGlobalId::from_public_key(&f.owner_pk)],
    );
    second.expect_commit_failure();
}

#[test]
fn test_agent_cannot_withdraw_badge() {
    let mut f = setup();
    let (agent_pk, _, agent_account) = f.ledger.new_allocated_account();
    let (_, _, third_party) = f.ledger.new_allocated_account();

    f.ledger
        .execute_manifest(
            mint_manifest(
                &f,
                agent_account,
                "alice",
                "account_rdx12dummy0000000000000000000000000000000000",
                dec!("100"),
                dec!("500"),
            ),
            vec![NonFungibleGlobalId::from_public_key(&f.owner_pk)],
        )
        .expect_commit_success();

    let manifest = ManifestBuilder::new()
        .lock_fee_from_faucet()
        .withdraw_non_fungibles_from_account(
            agent_account,
            f.agent_badge,
            [NonFungibleLocalId::integer(1)],
        )
        .try_deposit_entire_worktop_or_abort(third_party, None)
        .build();
    let receipt = f.ledger.execute_manifest(
        manifest,
        vec![NonFungibleGlobalId::from_public_key(&agent_pk)],
    );
    receipt.expect_commit_failure();
    assert_eq!(
        f.ledger.get_component_balance(agent_account, f.agent_badge),
        dec!("1")
    );
}
