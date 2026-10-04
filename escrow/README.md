# escrow/

Scrypto blueprints for Guild marketplace escrow.

## Active

- **[`scrypto/guild-marketplace-escrow/`](scrypto/guild-marketplace-escrow/)** — Canonical task escrow as of 2026-05-23. Multi-token, dual-vault (reward + insurance), pluggable arbiter, agent-aware timers, claim_bond + expire / cancel-after-claim lifecycle, three dispute rulings + time-gated auto-resolve. Design: [`../docs/ESCROW-DESIGN.md`](../docs/ESCROW-DESIGN.md).

## Deprecated (retained for reference)

- **[`scrypto/guild-escrow/`](scrypto/guild-escrow/)** — Pre-scan single-token escrow. Two high-severity findings from the 2026-05-23 in-house scrypto scan (worker role `allow_all`, arbiter accepts any badge). See its [`README.md`](scrypto/guild-escrow/README.md) for migration guidance. Do not modify; do not add as a dependency.

## Predecessor-repository legacy (not in this tree)

The Wave 2 deprecation also covered two earlier blueprints, `task-escrow` and `task-escrow-v3`, that lived in a
predecessor repository rather than in this one. That repository was archived on 2026-10-04 and is not maintained;
both blueprints are superseded by `guild-marketplace-escrow`, nothing in this tree builds or deploys them, and no
follow-up is planned there. Migrators should start from this directory.
