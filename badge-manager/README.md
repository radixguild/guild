# Badge Manager

Identity layer for Radix community governance. Mint, manage, and track badges across DAOs.
Folded into guild-saas from `guild-public` on 2026-08-14 (slice A) — this tree is the ONLY
source of the live mainnet BadgeManager.

## Status: Live on Mainnet

### Deployed Addresses (chain-verified 2026-08-14, mainnet Gateway)

| Entity | Address |
|--------|---------|
| Package | `package_rdx1phm53al5ztrfw8k5wa3qc5pllwfyeqgl4spjcy83ymgw8jhngx7vu3` |
| BadgeFactory | `component_rdx1cqxdsz6d3zjsjx7shk2fgg8dazmrknygvqsa4943yw0yz4e69taxhg` |
| BadgeManager (live — Guild Member badge) | `component_rdx1czexylvvm0q4uhwpjaqmlznj9sd3y2jnmmah6qug9lm9sfm3tyrtva` |

For the badge NFT resource, sibling managers (arbiter / role), and everything else, the ground
truth is `docs/ASSET-REGISTRY.md` (+ `.json`), kept in the private operations repository —
always re-verify against the Gateway rather than trusting any README table, including this one.

> ⚠️ An earlier version of this README documented a **stale, superseded deployment**
> (package `…ph03wnq…`, manager `…cqu2vky…`, the `rad_dao_player` era). Those addresses are
> NOT the live lineage. The table above is the chain-verified one.

### Version labels: v3 vs v4 — don't trust the label

The build artifacts in [`build-artifacts/`](build-artifacts/) carry both `v3` and `v4` labels,
and docs across the fleet have used both for the live contract. The last substantive contract
commit is guild-public `f207722` ("contract v4 — username as NFT ID, duplicate prevention" —
`26e4c45` in this repo's folded lineage, hashes rewritten by the history cut), so the current
source corresponds to the **v4-labelled** artifacts — but the labels were never applied
consistently. When it matters, verify by hash/behavior against the deployed package, not by
label.

## What It Does

- **BadgeFactory** — Deploy once, anyone can create their own badge manager
- **BadgeManager** — Mint, revoke, update tiers, track XP/levels
- **UniversalBadgeData** — Typed core fields + extensible extra_data JSON
- **Free mint** — `public_mint` lets anyone get a badge at zero cost
- **XP/Level system** — 5 levels: newcomer, contributor, builder, trusted, elder

Note the live Guild Member badge's operational caveats (chain-read 2026-07-31, see
`docs/PROJECT-COMPONENTS.md` §4): uniqueness is per *username* (the username IS the NFT id,
`src/lib.rs:195,287`), the badge is permanently transferable, and every `*_updater` role is
`DenyAll`.

## Build

```bash
cd scrypto/radix-badge-manager
scrypto build
scrypto test
```

Requires Scrypto 1.3.1 toolchain. ⚠️ **Build on Linux (CI or VPS)** — Scrypto WASM builds fail
on this project's Macs (bulk-memory issue; the operator's `CLAUDE.md` §Scrypto, kept in the
private operations repository, has the details).

## Architecture

```
BadgeFactory (deployed once)
    |
    +-- create_manager(schema, tiers, dapp_def) --> BadgeManager + Admin Badge
                                                        |
                                                        +-- public_mint(username) --> Badge NFT
                                                        +-- mint_badge(username, tier)
                                                        +-- revoke_badge(badge_id, reason)
                                                        +-- update_tier(badge_id, new_tier)
                                                        +-- update_xp(badge_id, new_xp)
                                                        +-- update_extra_data(badge_id, json)
                                                        +-- get_badge_info(badge_id)
                                                        +-- get_badge_resource()
```

## Badge Data (UniversalBadgeData)

| Field | Type | Mutable | Purpose |
|-------|------|---------|---------|
| issued_to | String | no | Username |
| schema_name | String | no | Badge schema identifier |
| issued_at | i64 | no | Mint timestamp |
| tier | String | yes | Current tier |
| status | String | yes | active / revoked |
| last_updated | i64 | yes | Last change timestamp |
| xp | u64 | yes | Experience points |
| level | String | yes | Auto-calculated from XP |
| extra_data | String | yes | JSON for custom fields |

## License

Originally released under Apache 2.0 in the `guild-public` repository; this repository's own
licence (Apache-2.0, `LICENSE` at the root) applies to the tree here.
