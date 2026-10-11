<!-- status: live
     verified: 2026-10-11 (index only: every date below was re-read from the document's own header
     that day, and every link resolves in this tree. The claims inside each document were not
     re-checked by this pass; each header says what its own `verified:` lines covered.) -->
# Docs — design and reference documents

These are the design and reference documents that ship with the code. The repository's own
[`README.md`](../README.md), [`CONTRIBUTING.md`](../CONTRIBUTING.md) and [`SECURITY.md`](../SECURITY.md)
cover running, changing and reporting; [`STATE.md`](../STATE.md) says what is currently true and wins
any conflict with a document here, and [`GOVERNANCE.md`](../GOVERNANCE.md) and
[`PROVENANCE.md`](../PROVENANCE.md) cover who decides and where the code came from. On-chain
addresses live in code, not in prose: the defaults in
[`guild-app/src/lib/config.ts`](../guild-app/src/lib/config.ts) are what the live site uses.

## Status legend

Each document carries a status header. **live** means its claims are meant to match the code and
the deployment. **proposal** is never an instruction. **historical** is a snapshot of a past
moment; neither of the last two is safe to act on today. `verified:` is the date a document's
claims were last checked, and many of its lines are scoped to one section, so read the header
before relying on a document whole. The Verified column below is the newest `verified:` line in
each header.

## Start here

| Doc | What it covers |
|---|---|
| [`HOW-IT-WORKS.md`](HOW-IT-WORKS.md) | How the Guild works, on one page |
| [`AUDITOR-GUIDE.md`](AUDITOR-GUIDE.md) | The deep, verifiable version: what to check and how |
| [`FEE-BUSINESS-MODEL.md`](FEE-BUSINESS-MODEL.md) | The fee model: workers pay 0%; the poster-side royalty is a flat XRD amount, 0 today (the doc's percentage plan is marked as history) |
| [`TASK-TERMS-DESIGN.md`](TASK-TERMS-DESIGN.md) | Task terms as data, the create wizard, trust tiers |
| [`TRUST-BACKING-PLAN.md`](TRUST-BACKING-PLAN.md) | Pseudonymous backing: open blueprint, bounty, bond |
| [`PROJECT-COMPONENTS.md`](PROJECT-COMPONENTS.md) | The project's components: what each is and what is built versus only designed |
| [`GUILD-VISION-2026.md`](GUILD-VISION-2026.md) | The product vision and design maxims (direction, not a commitment) |
| [`ESCROW-DESIGN.md`](ESCROW-DESIGN.md) | The escrow blueprint's design rationale (historical; its header notes where the deployed version differs) |

## Reference

| Doc | What it covers |
|---|---|
| [`ESCROW-METHOD-INVENTORY.md`](ESCROW-METHOD-INVENTORY.md) | Every escrow method, with its access class and return type. The signature table is generated from the source and checked in CI; it describes `main`, not a deployed package |
| [`ESCROW-MIGRATION-S1-METHOD-MAP.md`](ESCROW-MIGRATION-S1-METHOD-MAP.md) | How methods mapped across one escrow migration (historical) |
| [`SCRYPTO-AUTH-CONVENTION.md`](SCRYPTO-AUTH-CONVENTION.md) | How the blueprints express authorisation |
| [`BADGE-SCHEMAS.md`](BADGE-SCHEMAS.md) | The badge schemas |
| [`badges.md`](badges.md) | Badge notes (proposal) |
| [`THESIS.md`](THESIS.md) | The Guild thesis (proposal) |
| [`FEATURE-MAP.md`](FEATURE-MAP.md) | A June 2026 index of every feature the docs mentioned, shipped, planned or shelved (historical) |
| [`agent-lifecycle.md`](agent-lifecycle.md) | An agent-registration design that was never built (historical). The live agent path is [`packages/agent-client`](../packages/agent-client) |

## Full index

### Top level

| Doc | Status | Verified |
|---|---|---|
| [`AUDITOR-GUIDE.md`](AUDITOR-GUIDE.md) | live | 2026-10-06 |
| [`BADGE-SCHEMAS.md`](BADGE-SCHEMAS.md) | live | 2026-09-23 |
| [`ESCROW-DESIGN.md`](ESCROW-DESIGN.md) | historical | 2026-09-30 |
| [`ESCROW-METHOD-INVENTORY.md`](ESCROW-METHOD-INVENTORY.md) | live | 2026-09-21 |
| [`ESCROW-MIGRATION-S1-METHOD-MAP.md`](ESCROW-MIGRATION-S1-METHOD-MAP.md) | historical | 2026-08-15 |
| [`FEATURE-MAP.md`](FEATURE-MAP.md) | historical | 2026-10-08 |
| [`FEE-BUSINESS-MODEL.md`](FEE-BUSINESS-MODEL.md) | live | 2026-10-06 |
| [`GUILD-VISION-2026.md`](GUILD-VISION-2026.md) | live | 2026-10-11 |
| [`HOW-IT-WORKS.md`](HOW-IT-WORKS.md) | live | 2026-10-11 |
| [`PROJECT-COMPONENTS.md`](PROJECT-COMPONENTS.md) | live | 2026-10-11 |
| [`SCRYPTO-AUTH-CONVENTION.md`](SCRYPTO-AUTH-CONVENTION.md) | live | 2026-10-06 |
| [`TASK-TERMS-DESIGN.md`](TASK-TERMS-DESIGN.md) | live | 2026-10-11 |
| [`THESIS.md`](THESIS.md) | proposal | 2026-10-06 |
| [`TRUST-BACKING-PLAN.md`](TRUST-BACKING-PLAN.md) | live | 2026-10-02 |
| [`agent-lifecycle.md`](agent-lifecycle.md) | historical | 2026-10-02 |
| [`badges.md`](badges.md) | proposal | 2026-08-15 |

### decisions/ — architecture decision records

| Doc | Status | Verified |
|---|---|---|
| [`ADR-001-architectural-foundations.md`](decisions/ADR-001-architectural-foundations.md) | historical | 2026-05-29 |
| [`ADR-002-escrow-deploy-and-integration-gates.md`](decisions/ADR-002-escrow-deploy-and-integration-gates.md) | historical | 2026-05-29 |

### architecture/

| Doc | Status | Verified | What it is |
|---|---|---|---|
| [`custom-contracts.md`](architecture/custom-contracts.md) | proposal | 2026-05-19 | A custom-contract template system |
| [`dispute-resolution.md`](architecture/dispute-resolution.md) | live | 2026-09-17 | Dispute resolution: §0 (the operator runbook) is kept privately, §1–§3 are the original design, §4 is the implementation status |
| [`insurance-model.md`](architecture/insurance-model.md) | proposal | 2026-05-19 | An insurance model |
| [`system-map.md`](architecture/system-map.md) | historical | 2026-05-19 | The system architecture map, as first drawn |
| [`ui-shells.md`](architecture/ui-shells.md) | proposal | 2026-10-02 | UI shells |
