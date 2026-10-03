// Task marketplace constants

export const XP_THRESHOLDS: Record<string, number> = {
  member: 0,
  contributor: 100,
  builder: 500,
  steward: 2000,
  elder: 10000,
};

export const ROYALTIES = {
  mint: 1,
  revoke: 0.5,
  update_tier: 0.25,
  update_xp: 0.1,
  update_extra_data: 0.1,
};

// Insurance the poster locks alongside the reward, as a fraction of the reward.
// MUST be ≥ the deployed escrow `min_insurance_fraction` or create_task aborts
// on the insurance-floor assert. That floor is 0 on the live Wave B component
// (docs/ESCROW-ADDRESSES.md instantiate sheet, row 10; re-read on the Gateway
// 2026-09-17, state_version 558544023); the same registry records 0.05 for the
// v1 and vNext components, which is where this comment's old "(0.05)" came
// from — it outlived them and read as current until that re-read. UNLIKE the
// reward minimum below, it is an OWNER DIAL (`set_min_insurance_fraction`,
// range [0, 1]): raising it above this rate would revert every fund op, so
// re-read the chain before relying on the number. Was 0.02 against the old
// 0.05 floor (→ every fund op would have been a CommittedFailure).
export const INSURANCE_RATE = 0.05;

// The chain's OWN insurance floor — `min_insurance_fraction`, instantiate param
// 10 in docs/ESCROW-ADDRESSES.md, read back from the Gateway as `0`.
//
// THESE TWO NUMBERS ARE NOT THE SAME KIND OF THING, and served copy said they
// were until 2026-09-18: /money listed "minimum insurance fraction (0.05)"
// among values that "are all on-ledger", and /auditor-guide badged "Insurance
// min 5% of reward" as "Deployed today — ground truth per component address".
// Both printed INSURANCE_RATE, an app constant, and attributed it to the
// ledger. The ledger's floor is 0: the escrow would accept a task funded with
// no insurance at all. The 5% is this app's own policy, applied unconditionally
// when it builds the funding manifest, and nothing on chain requires it.
//
// It is also an OWNER DIAL (`set_min_insurance_fraction`, range [0, 1]) read at
// FUNDING, so a change reaches every task funded after it — which is what makes
// the invariant below worth asserting rather than assuming.
export const ESCROW_MIN_INSURANCE_FRACTION = 0;
// The smallest XRD reward the live escrow will FUND. `create_task` asserts
// `reward_amount >= min_amount` against the reward token's AcceptedTokenConfig
// (escrow lib.rs, panic "reward below per-token minimum"), and the live Wave B
// component registered XRD with min_amount 1 — docs/ESCROW-ADDRESSES.md, the
// XRD row; read back from the Gateway 2026-09-17 at state_version 558539826:
// `{ min_amount: "1", frozen: false }`.
//
// ONE definition, enforced on both sides of the wire: the create form's reward
// blocker (create-task-blockers.ts) and the API's reward schema
// (validation.ts — POST and PATCH). Before this existed both sides accepted any
// reward > 0, so "0.5" produced a DB task row whose funding tx could only
// revert: a poster stranded with a task nobody can ever fund.
//
// WHY A CONSTANT AND NOT A LIVE CHAIN READ — RULED by bigdev 2026-09-17 with
// these facts in front of him: keep the constant. (`frozen` on the same KVS
// entry IS read live — gateway.ts readXrdPostingFrozen.) `frozen` is mutable,
// this is not. `add_accepted_token` asserts "token already whitelisted" and the
// blueprint has no setter, so a component's per-token minimum is write-once;
// it can only differ from this constant after a component SWAP, which is
// already a config change + rebuild. That moment is what is gated instead:
// tests/unit/escrow-address-drift.test.ts fails unless this equals the
// min_amount the registry records for the component config.ts defaults to.
//
// A decimal STRING because it is a money amount (src/lib/xrd-decimal.ts) and
// the API compares it exactly. XRD ONLY — the minimum is per token on chain,
// and no non-XRD reward can be created today (`tasks.reward_resource` has no
// writer). When the reward-resource flip lands this becomes a per-token lookup,
// not a second constant. Mirrored in packages/agent-client/src/manifests.ts
// (that package builds outside this repo), parity-checked in its
// manifests.test.ts.
export const MIN_REWARD_XRD = "1";

// The escrow's OWN review window — `review_window_secs` on the live component,
// read back from the Gateway at 259200 (3 days) and recorded as instantiate
// param 15 in docs/ESCROW-ADDRESSES.md.
//
// NOT the same thing as a task's `reviewWindowDays` term (src/lib/task-terms.ts).
// That number is the POSTER'S PROMISE, committed into the brief as evidence and
// enforced by nobody. This one is the contract's, and it is what actually opens
// `release_after_review_timeout` to any caller once `submitted_at + this` passes.
// Copy that conflates the two tells a poster their own number is a deadline.
//
// UNLIKE `min_amount`, this one is MUTABLE: `set_review_window_secs` is
// OWNER-restricted and accepts 1–30 days (escrow lib.rs). So it is a constant
// that can genuinely go stale, which is why the drift test gates it against the
// registry — turn the dial on chain without recording it and CI goes red, which
// is the only thing that makes the served "3 days" re-read.
//
// An existing task is unaffected by a later tune: `review_deadline` is PINNED
// onto the task at `submit_task`, so changing this never moves a deadline a
// worker has already been given.
export const ESCROW_REVIEW_WINDOW_SECS = 259200;
export const ESCROW_REVIEW_WINDOW_DAYS = ESCROW_REVIEW_WINDOW_SECS / 86400;

// The API's own title/description maxima, named so BOTH sides of the wire read
// the same number. `createTaskSchema` and `updateTaskSchema` (validation.ts)
// enforce these; the create form's step-1 blocker (create-task-blockers.ts)
// checks them before the poster can advance.
//
// Before this existed the form enforced only the MINIMUMS, so a 201-character
// title cleared step 1 and step 2 and failed at Post Task as a raw zod error —
// after the poster had written the whole task.
//
// `createFundingPoolSchema` keeps its own literals deliberately: the numbers
// match today by coincidence, and pools are a separate feature whose limits
// should be free to move without dragging tasks with them.
export const TASK_TITLE_MAX_CHARS = 200;
export const TASK_DESCRIPTION_MAX_CHARS = 5000;
// The SHAPE a reward must have — a plain decimal, no sign, no exponent, at most
// REWARD_MAX_DECIMALS places — as ONE definition for the same two sides:
// validation.ts's rewardAmountSchema (the API's 400) and the create form's
// reward blocker (create-task-blockers.ts). It lives here, not in validation.ts,
// because this file has no imports and validation.ts pulls zod and DB schema
// enums, which the client form must not bundle.
//
// Before it was shared the form judged a reward with `Number()`, which accepts
// what this refuses: "1e3" and "1.000000001" both cleared step 2, reached Review,
// and only on Post Task came back as a raw zod error. A real browser's number
// input DOES deliver both to React (measured in Chromium, 2026-09-17).
// tests/unit/create-task-reward-parity.test.ts runs one table through both sides.
//
// ⚠️ 8 places is NOT a manifest-builder limit. validation.ts's xrdAmountSchema
// note said "max-8dp because that is what the ESCROW manifest builder accepts
// today" and this comment repeated it; both were wrong, caught by an
// adversarial review 2026-09-18 and measured: manifests.ts's `decimalArg` /
// `decimalStringArg` throw only above **18** places ("exceeds the chain's 18"),
// and createTaskManifest really does emit `Decimal("1.123456789")` for a
// 9-place reward. packages/agent-client's mirror caps at 18 too.
//
// What the cap actually protects, today: sendDepositTx computes the poster's
// insurance as `Math.ceil(params.rewardXrd * INSURANCE_RATE)` — a JS FLOAT
// multiply (escrow-utils.ts) — and 8 places keeps every reward well inside a
// double's ~15–17 significant digits. funding-pools/route.ts states the same
// dependency from the other side, and is why its own 18dp target uses exact
// BigInt (`ceilXrdMultiple`) instead. Raising this number without moving that
// multiply to exact arithmetic reintroduces float error into a money figure.
// The ORIGIN of 8 is not recorded anywhere in the repo; that dependency is.
//
// The digit count is its own constant so the form's message can name the
// number the regex enforces.
export const REWARD_MAX_DECIMALS = 8;
// ...and so is the INTEGER digit count, for the same reason and a harder one:
// without it this regex was `^\d+(...)` — unbounded — while every XRD money
// column is `numeric(38, 18)`, which holds 38 - 18 = 20 integer digits. A
// 21-digit reward therefore passed the create form, passed `rewardAmountSchema`
// on both POST and PATCH, reached the INSERT, and came back as a Postgres
// `22003 numeric field overflow` that nothing catches: `fromError` only maps
// `AppError`, so the poster got **500 INTERNAL_ERROR "Internal server error"**
// where the contract is a 400 VALIDATION_ERROR — and, on the form, a wizard
// that cleared every step and then broke at Post Task. Measured end-to-end
// against a real Postgres (pglite) through the REAL route handlers, 2026-09-18:
// 20 digits -> 201, 21 digits -> 500 on POST /api/v1/tasks and on PATCH
// /api/v1/tasks/[id]. Surfaced by an adversarial review of PR #705.
//
// 20 is NOT a taste number and must never be hand-edited: it is
// `precision - scale` of the column the value lands in.
// tests/unit/xrd-int-digits-column-parity.test.ts reads that pair off the real
// drizzle schema for every numeric XRD column a user-supplied amount reaches
// and fails if this constant stops equalling it — so a migration that widens or
// narrows the column cannot silently leave this behind.
//
// SHARED with validation.ts's `xrdAmountSchema` (funding-pool `target_xrd` and
// pledge `amount_xrd` — the same numeric(38,18), the same gap), which is why it
// is named for XRD and not for the reward. The DECIMAL cap differs between the
// two (8 here, 18 there); the integer cap cannot, because it is the column's.
//
// It caps digits WRITTEN, which is deliberately a hair stricter than the column
// itself: Postgres judges the VALUE, so it would accept 21 characters of
// leading zeros. Nothing renders that and the direction is fail-closed — it can
// never let an overflow through, it can only refuse an absurd spelling of a
// small number. Every real spelling of the zero lane rewardAmountSchema
// documents ("0", "00", "0.0", "0.00000000") is far inside 20 and unaffected.
export const XRD_MAX_INT_DIGITS = 20;
export const REWARD_SHAPE_RE = new RegExp(
  `^\\d{1,${XRD_MAX_INT_DIGITS}}(\\.\\d{1,${REWARD_MAX_DECIMALS}})?$`,
);
// Display-only: the deployed escrow auto-resolves disputes after 3 days
// (dispute_auto_resolve_secs = 259200 = 72h). Not a per-task create_task param —
// the window is fixed at instantiate.
export const DEFAULT_DISPUTE_WINDOW_HOURS = 72;
// ⚠️ TASK_XP_REWARDS was deleted 2026-08-21. It had ZERO importers and its
// numbers (complete 50, post 25, arbitrate 100) were the same three wrong
// figures the /docs XP table shipped — a dead constant that read as the source
// of truth for anyone who found it. The real numbers: completion XP is
// per-task, set at create from getTierForReward() (lib/incentives.ts) and
// awarded by escrow-confirm.ts; posting XP is the bot's, and only for the
// Telegram path; nothing anywhere awards XP for arbitration.

// A comfortable XRD cushion for a transaction's OWN network fee, on top of
// whatever that transaction locks or stakes. ONE definition, three call sites:
// the mint page's zero-balance/low-balance split (src/app/mint/page.tsx, where
// the tx locks nothing so the cushion IS the whole requirement), and the two
// escrow money actions' balance pre-flights (EscrowDepositButton,
// EscrowClaimButton — where it is the headroom ABOVE reward+insurance and
// above the claim bond respectively).
//
// Not a protocol constant and not a fee estimate: Radix fees here run well
// under 1 XRD, so this is a deliberately generous hint, and it only ever
// drives a SOFT, non-blocking warning. It must never gate a button — a poster
// or worker whose balance covers the locked amount might well have plenty for
// the fee, and blocking them would be the fail-closed direction the
// pre-flights' contract forbids (see useXrdBalance.ts).
export const FEE_HEADROOM_XRD = 1;
