# escrow

Scrypto blueprints for the Guild's on-chain task escrow and NFT swap.

## Active

- **[`scrypto/guild-marketplace-escrow/`](scrypto/guild-marketplace-escrow/)** is the canonical
  crate. It holds two blueprints:
  - **`Escrow`** (`src/lib.rs`, about 3,500 lines): the task escrow. Multi-token, dual-vault
    (reward and insurance), pull settlement, a proportional claim bond, expiry and
    cancel-after-claim, three dispute rulings and a time-gated auto-resolve. `instantiate` takes 15
    arguments: the worker-, arbiter- and optional agent-badge resources plus twelve settings. Live
    as Wave B since 2026-09-13.
  - **`NftSwap`** (`src/nft_swap.rs`, about 800 lines): an atomic NFT listing and fill. Live since
    2026-09-15.

  Build and test with the toolchain pinned in `rust-toolchain.toml` (Rust 1.92.0); the WASM build
  needs Linux or a Linux container. Design rationale (historical): [`../docs/ESCROW-DESIGN.md`](../docs/ESCROW-DESIGN.md).
  Every method and its access class: [`../docs/ESCROW-METHOD-INVENTORY.md`](../docs/ESCROW-METHOD-INVENTORY.md).
  Live addresses: [`../STATE.md`](../STATE.md) and `guild-app/src/lib/config.ts`.

## Deprecated (retained for reference)

- **[`scrypto/guild-escrow/`](scrypto/guild-escrow/)** is the pre-scan single-token escrow. Two
  high-severity findings from the 2026-05-23 in-house scrypto scan (worker role `allow_all`,
  arbiter accepts any badge) retired it. See its [`README.md`](scrypto/guild-escrow/README.md) for
  migration guidance. Do not modify it; do not add it as a dependency.

## Predecessor-repository legacy (not in this tree)

The Wave 2 deprecation also covered two earlier blueprints, `task-escrow` and `task-escrow-v3`,
that lived in a predecessor repository rather than in this one. That repository was archived on
2026-10-04 and is not maintained; both blueprints are superseded by `guild-marketplace-escrow`,
nothing in this tree builds or deploys them, and no follow-up is planned there. Migrators should
start from this directory.
