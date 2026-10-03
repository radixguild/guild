// GENERATED — DO NOT EDIT BY HAND.
//
//   bun scripts/gen-instantiate-manifest.mjs --emit-artifact
//
// Source of truth: docs/ESCROW-PARAMETER-SHEET.md §"Wave B — the signed sheet"
// (signed 2026-08-31, re-signed 2026-09-01). Regenerating is the ONLY correct
// way to change anything below; tests/unit/escrow-instantiate-gate.test.ts
// regenerates from the sheet and byte-compares, so a hand-edit goes red.
//
// Unlike most "do not edit" banners in this repo — one of which guarded a doc
// nothing regenerated for four ABI changes — this one names a real generator and
// a real gate that enforces it.
//
// `literal: null` marks a CEREMONY input, of which there are two kinds:
// source "deploy" = an address the sheet only NAMES (truncated, by filename,
// or as `Some(GAGENT)`); source "ceremony" = a USD POLICY value (rows 12/13,
// bond floor/cap) whose token amount is computed at the ceremony rate and
// verified against the signed policy by the generator. Never defaulted.

export type InstantiateArgSpec = {
  index: number
  name: string
  kind: "Address" | "OptionAddress" | "Decimal" | "u64" | "Enum"
  source: "sheet" | "deploy" | "ceremony"
  literal: string | null
}

export const INSTANTIATE_SPEC: readonly InstantiateArgSpec[] = [
  { index: 1, name: "worker_badge_resource", kind: "Address", source: "deploy", literal: null },
  { index: 2, name: "arbiter_badge_resource", kind: "Address", source: "deploy", literal: null },
  { index: 3, name: "agent_badge_resource", kind: "OptionAddress", source: "deploy", literal: null },
  { index: 4, name: "max_arbiter_fee_pct", kind: "Decimal", source: "sheet", literal: "Decimal(\"0.1\")" },
  { index: 5, name: "human_submit_deadline_secs", kind: "u64", source: "sheet", literal: "604800u64" },
  { index: 6, name: "agent_submit_deadline_secs", kind: "u64", source: "sheet", literal: "86400u64" },
  { index: 7, name: "dispute_auto_resolve_secs", kind: "u64", source: "sheet", literal: "259200u64" },
  { index: 8, name: "expire_grace_secs", kind: "u64", source: "sheet", literal: "3600u64" },
  { index: 9, name: "dispute_auto_resolve_default", kind: "Enum", source: "sheet", literal: "Enum<1u8>()" },
  { index: 10, name: "min_insurance_fraction", kind: "Decimal", source: "sheet", literal: "Decimal(\"0\")" },
  { index: 11, name: "claim_bond_pct", kind: "Decimal", source: "sheet", literal: "Decimal(\"0.10\")" },
  { index: 12, name: "claim_bond_floor", kind: "Decimal", source: "ceremony", literal: null },
  { index: 13, name: "claim_bond_cap", kind: "Decimal", source: "ceremony", literal: null },
  { index: 14, name: "expire_bounty_pct", kind: "Decimal", source: "sheet", literal: "Decimal(\"0.10\")" },
  { index: 15, name: "review_window_secs", kind: "u64", source: "sheet", literal: "259200u64" },
] as const
