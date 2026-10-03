//! gen_arbiter_badge_manifest — emit the Wave B arbiter badge MINT manifest.
//!
//! Ceremony step 2a. The badge is the write-once `arbiter_badge_resource`
//! instantiate arg, and since the L6(c) guard its non-fungible data is a MINT
//! CONTRACT: `resolve_dispute` decodes it as `ArbiterBadgeData`, and a badge
//! minted with any other shape bricks every arbiter ruling until a component
//! swap.
//!
//! WHY A RUST EXAMPLE AND NOT A HAND-WRITTEN .rtm: the schema. RTM's
//! CREATE_NON_FUNGIBLE_RESOURCE_WITH_INITIAL_SUPPLY embeds a full SBOR schema
//! literal, and hand-writing one is exactly the class of silent mistake the
//! instantiate generator exists to prevent. This example builds the manifest
//! with `ManifestBuilder` FROM THE SAME `ArbiterBadgeData` TYPE the blueprint
//! decodes — the schema cannot disagree with the decoder, because they are the
//! same Rust type in the same crate. It then decompiles to RTM for the wallet.
//!
//! Runs HOST-SIDE (no wasm32), so it works on the Mac:
//!
//!   cargo run --example gen_arbiter_badge_manifest -- \
//!       <assigned_account>  # the account this badge's identity names (L3(b))
//!       <deposit_account>   # where the minted badge lands
//!       <owner_badge_resource>  # gates the recovery mint/burn (see below)
//!
//! ROLE DECISIONS, stated because they are permanent:
//!  - withdrawer = DenyAll, withdrawer_updater = DenyAll: NON-TRANSFERABLE,
//!    forever, per the sheet's row 2. The deposit below is the badge's only
//!    move, ever. ⚠️ Deposit to the WRONG account is therefore unrecoverable
//!    by transfer — which is why mint/burn exist:
//!  - minter/burner = require(owner badge), updaters = DenyAll: the RECOVERY
//!    path. A lost or mis-assigned badge cannot be moved, and the resource
//!    address is write-once on the component — without a mint path, losing the
//!    badge would kill the human-arbiter path for the component's whole life
//!    (auto-resolve only). Owner-gated mint lets the operator mint #2 assigned
//!    to a fresh account and burn the stray. This deliberately means supply is
//!    NOT hard-capped at 1 — the cap is the owner badge's custody, same as
//!    every other owner power. E4 (no arbiter corps through external v1) is a
//!    posture the operator holds, not a chain constraint.
//!  - assigned_account is DATA, not a role: it is what the self-dealing guard
//!    compares to task.worker_account. It should normally equal the deposit
//!    account; the example warns loudly when they differ.

use scrypto_test::prelude::*;

use guild_marketplace_escrow::ArbiterBadgeData;

fn parse_component(decoder: &AddressBech32Decoder, s: &str, label: &str) -> ComponentAddress {
    ComponentAddress::try_from_bech32(decoder, s)
        .unwrap_or_else(|| panic!("{label}: not a valid mainnet account address: {s}"))
}

fn parse_resource(decoder: &AddressBech32Decoder, s: &str, label: &str) -> ResourceAddress {
    ResourceAddress::try_from_bech32(decoder, s)
        .unwrap_or_else(|| panic!("{label}: not a valid mainnet resource address: {s}"))
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 4 {
        eprintln!(
            "usage: cargo run --example gen_arbiter_badge_manifest -- \\\n\
             \x20    <assigned_account> <deposit_account> <owner_badge_resource>\n\n\
             assigned_account     account_rdx1… the badge's L3(b) identity — what the\n\
             \x20                    self-dealing guard compares to task.worker_account\n\
             deposit_account      account_rdx1… where the badge lands (non-transferable:\n\
             \x20                    this is its only move, ever)\n\
             owner_badge_resource resource_rdx1… gates the recovery mint/burn"
        );
        std::process::exit(2);
    }

    let network = NetworkDefinition::mainnet();
    let decoder = AddressBech32Decoder::new(&network);
    let assigned_account = parse_component(&decoder, &args[1], "assigned_account");
    let deposit_account = parse_component(&decoder, &args[2], "deposit_account");
    let owner_badge = parse_resource(&decoder, &args[3], "owner_badge_resource");

    if assigned_account != deposit_account {
        eprintln!(
            "  ⚠️  assigned_account != deposit_account.\n\
             \x20    The guard compares assigned_account; the badge SITS in deposit_account.\n\
             \x20    Divergence is expressible but almost never what a ceremony wants —\n\
             \x20    re-check before signing.\n"
        );
    }

    let manifest = ManifestBuilder::new()
        .create_non_fungible_resource(
            // Owner: the escrow owner badge. Metadata stays correctable by the
            // operator; every ROLE below carries its own DenyAll updater, so
            // the owner cannot loosen transferability later.
            OwnerRole::Fixed(rule!(require(owner_badge))),
            NonFungibleIdType::Integer,
            true, // track_total_supply — supply is a public custody fact
            NonFungibleResourceRoles {
                mint_roles: mint_roles! {
                    minter => rule!(require(owner_badge));
                    minter_updater => rule!(deny_all);
                },
                burn_roles: burn_roles! {
                    burner => rule!(require(owner_badge));
                    burner_updater => rule!(deny_all);
                },
                withdraw_roles: withdraw_roles! {
                    withdrawer => rule!(deny_all);
                    withdrawer_updater => rule!(deny_all);
                },
                ..Default::default()
            },
            metadata! {
                init {
                    "name" => "Guild Escrow Arbiter Badge (Wave B)", locked;
                    "description" => "Identity-bearing arbiter badge for guild-marketplace-escrow Wave B. Non-transferable; NF data is the ArbiterBadgeData mint contract (assigned_account) read by resolve_dispute's self-dealing guard.", locked;
                }
            },
            Some([(
                NonFungibleLocalId::integer(1),
                ArbiterBadgeData { assigned_account },
            )]),
        )
        .try_deposit_entire_worktop_or_abort(deposit_account, None)
        .build();

    // `decompile` itself is not re-exported by scrypto-test; the dumper (which
    // wraps it) is. Emitting through the dumper keeps this example inside the
    // one dev-dependency the crate already has.
    let out_dir = std::env::temp_dir().join("guild-arbiter-badge-manifest");
    scrypto_test::utils::dump_manifest_to_file_system(
        &manifest,
        &out_dir,
        Some("arbiter-badge-mint"),
        &network,
    )
    .expect("decompile/dump failed — the built manifest should always decompile");
    let rtm_path = out_dir.join("arbiter-badge-mint.rtm");
    let rtm = std::fs::read_to_string(&rtm_path).expect("reading the dumped manifest back");

    eprintln!("  Arbiter badge mint — Wave B ceremony step 2a.");
    eprintln!("  Schema source: guild_marketplace_escrow::ArbiterBadgeData (the decoder's own type).");
    eprintln!("  Roles: non-transferable forever; mint/burn owner-gated (the recovery path).");
    eprintln!("  ⚠️  PREPEND lock_fee before signing; record the resulting resource address");
    eprintln!("      — it is instantiate arg 2, write-once.");
    eprintln!("  Also written to {}\n", rtm_path.display());
    println!("{rtm}");
}
