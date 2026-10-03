# escrow/

Scrypto blueprints for Guild marketplace escrow.

## Active

- **[`scrypto/guild-marketplace-escrow/`](scrypto/guild-marketplace-escrow/)** — Canonical task escrow as of 2026-05-23. Multi-token, dual-vault (reward + insurance), pluggable arbiter, agent-aware timers, claim_bond + expire / cancel-after-claim lifecycle, three dispute rulings + time-gated auto-resolve. Design: [`../docs/ESCROW-DESIGN.md`](../docs/ESCROW-DESIGN.md).

## Deprecated (retained for reference)

- **[`scrypto/guild-escrow/`](scrypto/guild-escrow/)** — Pre-audit single-token escrow. Two high-severity findings from the 2026-05-23 audit (worker role `allow_all`, arbiter accepts any badge). See its [`README.md`](scrypto/guild-escrow/README.md) for migration guidance. Do not modify; do not add as a dependency.

## Sibling-repo legacy (not in this tree)

The Wave 2 deprecation also covers two blueprints living in the `guild-public` repository, not in this one:

- `badge-manager/scrypto/task-escrow-v3/`
- `badge-manager/scrypto/task-escrow/`

A follow-up PR in that repo will mark them as superseded by `guild-marketplace-escrow` and point migrators here.
