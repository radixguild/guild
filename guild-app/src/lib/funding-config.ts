// FundingPool app-layer constants (community-funded tasks, the threshold-
// crowdfund MVP feature — docs/design/funding-pool-blueprint.md, ruled at the
// ▶ 2026-08-14 decision sitting, PROJECT-STATE.md).
//
// These mirror the blueprint doc's §10 constants table AT THE VALUES THAT
// TABLE GIVES — this file does not re-decide anything §4b or the sitting
// already ruled. Two entries below are marked ⚠️ OPEN because the SAME source
// doc marks them open: do not read a default's mere presence as a ruling.

import { INSURANCE_RATE } from "@/lib/marketplace";

// ── [§4b D3 — ruled] deadline window ────────────────────────────────────────
export const FUNDING_MIN_DEADLINE_SECS = 7 * 24 * 60 * 60; // 7d
export const FUNDING_MAX_DEADLINE_SECS = 30 * 24 * 60 * 60; // 30d
export const FUNDING_DEFAULT_DEADLINE_SECS = 14 * 24 * 60 * 60; // 14d, poster's default

// ── [blueprint-level] proposal, not a §4b ruling — funding-pool-blueprint.md
// §10 lists both as "proposal" status, picked for the reasons given there
// (D5's liveness escape needs a window long enough a human presses the
// finalize button; recovery needs long enough a worker had a fair chance to
// claim). Fine to carry into the app layer now; revisit if Wave-B's blueprint
// build picks different numbers — this file follows that doc, not the other
// way around.
export const FUNDING_GRACE_WINDOW_SECS = 7 * 24 * 60 * 60; // 7d
export const FUNDING_RECOVERY_WINDOW_SECS = 30 * 24 * 60 * 60; // 30d

// ── [§4b — ruled] insurance ──────────────────────────────────────────────────
// Poster pre-pays `target * FUNDING_INSURANCE_FRACTION` at open time (§4b
// "Insurance"). MUST equal the deployed escrow's `min_insurance_fraction`
// (asserted at the blueprint's own `instantiate`, §5) — reuse the existing
// constant rather than re-declaring 0.05 a second place it can drift from.
export const FUNDING_INSURANCE_FRACTION = INSURANCE_RATE;

// ── ⚠️ OPEN — §4b D4's one unruled constant (funding-pool-blueprint.md §10,
// row "min_contribution"; vps-mvp-drafts-review.md §4b row "D4 minimum").
// Intent: "~$0.50 equivalent". A USD floor on an XRD rail needs an oracle or
// it drifts, so the ruled shape is "set the floor in XRD, record the USD
// intent beside it" — but the XRD FIGURE ITSELF is explicitly not decided:
// the design doc's own binding constraint (must comfortably exceed one
// `claim_refund` tx fee, "≥ ~20x measured fee") can only be measured once the
// FundingPool blueprint exists and its T-5 Stokenet step runs. Nobody has run
// T-5. THE VALUE BELOW IS A PLACEHOLDER so pledging has a testable floor —
// it is not a ruling, and shipping it live without T-5 would be inventing an
// answer to an open decide-box. Surfaced in this PR's decisions_owed.
export const FUNDING_MIN_CONTRIBUTION_XRD_DEFAULT = "5";
export const FUNDING_MIN_CONTRIBUTION_INTENT_USD = 0.5;

// ── ⚠️ OPEN — patronage XP (funding-pool-blueprint.md §1, row "Patronage XP",
// marked "PROPOSAL, not ruled" in the doc's own words: "No XP ruling exists
// in §4b or the 2026-08-14 sitting — the '+10 flat' figure comes from VPS
// research summaries, and this doc previously mislabelled it as ruled."
// Two things ARE ruled and this constant must respect them: amount-blind
// (never per-XRD — §12 DO-NOT list, so a whale can't buy XP) and it must stay
// far below completion XP (getTierForReward in lib/incentives.ts: 10/25/50/
// 100 by task tier) so funding a task is never a shortcut around doing one —
// LANE brief: "completion +50 must stay >> funding". The design doc also
// flags that live completion XP is TIER-SCALED, not the flat 50 the LANE
// brief's shorthand implies, so this figure needs reconciling against that
// table before it ships live, not just against the flat number. Kept as a
// config constant, not wired into any XP-awarding path yet — see
// decisions_owed.
export const FUNDING_PATRONAGE_XP_DEFAULT = 10;

// ── XRD-only for MVP (funding-pool-blueprint.md §2: "the pool asserts
// contribution.resource == XRD and creates XRD tasks only"). Not a tunable —
// exported as a literal so callers can assert against it rather than
// hardcoding "XRD" a second place.
export const FUNDING_ACCEPTED_RESOURCE = "XRD" as const;
