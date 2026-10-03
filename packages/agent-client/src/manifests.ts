// Escrow lifecycle manifest builders — agent-relevant subset (claim + submit),
// mirroring guild-saas/guild-app/src/lib/manifests.ts byte-for-byte so the
// agent submits the SAME proven manifest shapes the web app produces against
// the deployed guild_marketplace_escrow component.
//
// The agent path presents the AGENT badge (operator-minted; the blueprint's
// claimer_is_agent flow) instead of the Guild member badge — same manifest,
// different badge resource. Constants flow in from config (env-overridable).
//
// Every builder here was import-free until P1-19's `createTaskManifest`, which
// withdraws the poster's OWN reward + insurance in native XRD — a resource
// that, unlike `escrowComponent`/`badgeResource`/etc., is never a per-caller
// argument and never env-overridable, so it is not something a caller can be
// trusted to hand in (a wrong resource here would silently fund the wrong
// asset). `MAINNET_XRD` is imported from `./config.js` rather than re-declared
// as a second literal, precisely because a second hand-typed copy is how the
// guild PR #107 "…stcfkr" regression happened — one source, imported, is what
// makes that class of drift structurally impossible instead of merely tested.
import { MAINNET_XRD } from './config.js';

// ── validators (ports of the guild-app helpers; fail closed) ────────────────

function validateAddress(addr: string, prefix: string): string {
  // The trailing `$` is load-bearing. Without it, `[a-z0-9]{20,}` matches a valid
  // prefix followed by ANYTHING — the regex stops after 20 alnums — so an address like
  // `account_rdx1aaaaaaaaaaaaaaaaaaaa")<newline><injected manifest>` passes .test() and
  // then flows verbatim into `Address("${addr}")`, breaking out of the string literal.
  // Real Radix addresses are all-lowercase bech32m to the end, so anchoring rejects only
  // malformed/hostile input; the byte output for any valid address is unchanged.
  if (!new RegExp(`^${prefix}[a-z0-9]{20,}$`).test(addr)) {
    throw new Error(`Invalid ${prefix} address`);
  }
  return addr;
}

function validatePositiveInt(n: number, name: string): number {
  // > MAX_SAFE_INTEGER: Number.isInteger stays true but the value is no longer exactly
  // representable, so `${n}u64` would emit a DIFFERENT id than intended (2^53+1 → 2^53).
  // Task/receipt ids are on-chain u64; refuse anything past the safe range rather than
  // sign a manifest against the wrong task. (Real sequential ids never approach 2^53.)
  if (!Number.isInteger(n) || n <= 0 || n > Number.MAX_SAFE_INTEGER) {
    throw new Error(`Invalid ${name}: must be a positive integer`);
  }
  return n;
}

// Escrow task ids + claim-receipt ids are u64 integers on-chain → `#N#`.
function intLocalId(n: number, name: string): string {
  return `#${validatePositiveInt(n, name)}#`;
}

// Strict NonFungibleLocalId validator for ids supplied as strings (the agent
// badge id comes from env). Whitelists the four valid forms.
function validateLocalId(id: string, name: string): string {
  if (!/^(#\d+#|<[A-Za-z0-9_]+>|\{[0-9a-fA-F-]+\}|\[[0-9a-fA-F]+\])$/.test(id)) {
    throw new Error(`Invalid ${name}: not a valid NonFungibleLocalId`);
  }
  return id;
}

// 32-byte commitment (evidence hash) → Bytes("<64 hex>").
function validateHashHex(hex: string, name: string): string {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]{64}$/.test(h)) {
    throw new Error(`Invalid ${name}: must be a 32-byte hex string (64 chars)`);
  }
  return h.toLowerCase();
}

// `decimalArg` (number → validated Decimal string; rejects exponential
// notation and float artifacts past 18dp) stood here with no caller from Wave B
// (claimTaskManifest's flat `claimBondXrd: number`) until the claim-bond port
// moved that builder onto the BigInt-exact `decimalStringArg` (below
// `formatAttos`) instead — reaching the builder as an already-exact STRING.
// REINSTATED for P1-19 (poster SDK): `createTaskManifest`'s `rewardXrd` /
// `insuranceXrd` are plain `number`s on the guild-app side of the byte-parity
// guard, so the client builder must accept the same shape — see `decimalArg`'s
// own doc comment, below `computeInsuranceXrd`, for why `decimalStringArg`
// doesn't fit here.

/**
 * Exact Scrypto-Decimal comparison scaling: an 18dp fixed-point decimal string
 * → its integer subunit count as a bigint, so "10", "10.0" and
 * "10.000000000000000000" all compare equal while floats never touch the
 * value. Restored from the retired heartbeat-economics leg (#256 → #339),
 * where it priced the bond drain; here it backs the claim-bond chain
 * cross-check. Throws on anything BigInt can't parse (exponential notation,
 * empty, garbage) — callers comparing money treat a throw as a mismatch.
 */
export function scaleDecimal(v: string): bigint {
  const [whole, frac = ''] = v.split('.');
  return BigInt(whole + frac.padEnd(18, '0').slice(0, 18));
}

/** scaleDecimal's inverse: an 18dp-attos bigint → its minimal decimal string
 * ("5000000000000000000" → "5", not "5.000000000000000000"). Used to turn
 * `requiredBond`'s exact integer arithmetic back into manifest text.
 */
export function formatAttos(attos: bigint): string {
  if (attos < 0n) {
    throw new Error('formatAttos: negative amount — refusing to format as a manifest Decimal');
  }
  const s = attos.toString().padStart(19, '0');
  const whole = s.slice(0, -18) || '0';
  const frac = s.slice(-18).replace(/0+$/, '');
  return frac.length > 0 ? `${whole}.${frac}` : whole;
}

/**
 * Faithful port of the escrow blueprint's `required_bond` (lib.rs, Wave B
 * W4) — the proportional claim-bond formula: `pct * reward`, clamped to
 * `[floor, cap]` (floor applied before cap, matching the blueprint exactly —
 * `instantiate` and the setter both assert `cap >= floor`, so the order is
 * belt-and-braces there too, not a behavioural choice), rounded DOWN to what
 * the reward token's divisibility can express.
 *
 * Every step is BigInt arithmetic over each Decimal's exact 18dp
 * fixed-point subunit representation (`scaleDecimal`) — never `Number`,
 * which cannot represent an 18dp Scrypto `Decimal` exactly and would round
 * differently than the chain does. Verified against the actual on-chain
 * types (radix-common's `decimal.rs`, vendored locally), not assumed:
 *
 *   - `reward * pct`: `Decimal::checked_mul` multiplies the two 18dp
 *     fixed-point integers (widened to avoid overflow) and divides by
 *     10^18 with truncating integer division. Both operands are
 *     non-negative here (the blueprint asserts `claim_bond_pct` ∈ [0,1] and
 *     rejects a negative reward), so truncating division IS a floor — plain
 *     BigInt division reproduces it exactly.
 *   - `checked_round(divisibility, RoundingMode::ToZero)`: `rounding_mode.rs`
 *     resolves `ToZero` on a non-negative `Decimal` to `RoundDown`, i.e.
 *     truncate to `divisibility` decimal places by zeroing the trailing
 *     `(18 - divisibility)` atto-digits — never "round to nearest", and
 *     never up, regardless of what the dropped digits are.
 *
 * `divisibility` is the reward token's ACTUAL on-chain divisibility (0-18) —
 * read live via `gateway.ts`'s `readTokenDivisibility`, never assumed (not
 * even 18 for XRD).
 */
export function requiredBond(
  reward: string,
  pct: string,
  floor: string,
  cap: string,
  divisibility: number
): string {
  if (!Number.isInteger(divisibility) || divisibility < 0 || divisibility > 18) {
    throw new Error(`Invalid divisibility: ${divisibility} (must be an integer in 0..18)`);
  }
  const ONE = 10n ** 18n;
  const rewardAttos = scaleDecimal(reward);
  const pctAttos = scaleDecimal(pct);
  const floorAttos = scaleDecimal(floor);
  const capAttos = scaleDecimal(cap);
  if (rewardAttos < 0n || pctAttos < 0n || floorAttos < 0n || capAttos < 0n) {
    throw new Error('requiredBond: reward/pct/floor/cap must all be non-negative');
  }
  const rawAttos = (rewardAttos * pctAttos) / ONE;
  const clampedAttos = rawAttos < floorAttos ? floorAttos : rawAttos > capAttos ? capAttos : rawAttos;
  const dropPlaces = 18 - divisibility;
  const divisor = 10n ** BigInt(dropPlaces);
  const roundedAttos = clampedAttos - (clampedAttos % divisor);
  return formatAttos(roundedAttos);
}

/**
 * Poster-side insurance rate — byte-for-byte mirror of guild-app's
 * `INSURANCE_RATE` (src/lib/marketplace.ts). `create_task` reverts unless
 * `insurance >= min_insurance_fraction * reward` (deployed min_insurance_fraction
 * is 0, so any non-negative insurance clears it today, but this is the rate the
 * app itself FUNDS at — see `computeInsuranceXrd`). A local constant, not an
 * import: this package builds outside the monorepo (P4-6), so the value is
 * duplicated on purpose and cross-checked byte-for-byte by
 * manifests.test.ts's insurance-math parity block, the same discipline
 * `MAINNET_XRD`/`assertCanonicalXrd`-style constants get elsewhere in this file.
 */
export const INSURANCE_RATE = 0.05;

/**
 * The smallest XRD reward the live escrow will FUND — byte-for-byte mirror of
 * guild-app's `MIN_REWARD_XRD` (src/lib/marketplace.ts). `create_task` asserts
 * `reward_amount >= min_amount` against the reward token's AcceptedTokenConfig
 * (panic "reward below per-token minimum"), and the live component registered
 * XRD with min_amount 1 (docs/ESCROW-ADDRESSES.md, the XRD row). The server
 * refuses a reward in (0, this) with a 400 VALIDATION_ERROR; `runPost` refuses
 * it locally first so neither a dry-run preview nor a `--live` post gets as far
 * as a manifest the chain can only revert. A local constant for the same
 * reason `INSURANCE_RATE` is one (this package builds outside the monorepo),
 * cross-checked by manifests.test.ts's reward-minimum parity block. XRD only:
 * the on-chain minimum is per token, and this package posts XRD rewards only.
 */
export const MIN_REWARD_XRD = '1';

/**
 * The insurance a `create_task` funding leg must post for a given reward,
 * rounded exactly the way guild-app's `sendDepositTx` rounds it
 * (escrow-utils.ts: `Math.ceil(params.rewardXrd * INSURANCE_RATE)`) and the
 * way `poster-harness.mjs`'s `createAndFundTask` independently reproduces it.
 * Deliberately `Math.ceil` on a `number`, NOT BigInt-exact like `requiredBond`
 * — this mirrors the app's actual (whole-XRD) rounding behavior byte-for-byte
 * rather than a "more correct" reimplementation that would fund a different
 * amount than the manifest the server itself builds for the same reward.
 */
export function computeInsuranceXrd(rewardXrd: number): number {
  return Math.ceil(rewardXrd * INSURANCE_RATE);
}

/**
 * Non-negative decimal STRING validator (as opposed to `decimalStringArg`,
 * which also rejects zero by default) — byte-for-byte port of guild-app's
 * `validateDecimal`, used for `arbiterFeePct`. Deliberately looser than
 * `decimalStringArg`: an arbiter fee of exactly "0" is the launch default
 * (escrow-utils.ts sendDepositTx hardcodes it) and must validate.
 */
function validateDecimal(val: string, name: string): string {
  if (!/^\d+(\.\d+)?$/.test(val)) {
    throw new Error(`Invalid ${name}: must be a non-negative decimal string`);
  }
  return val;
}

/**
 * Byte-for-byte port of guild-app's `decimalArg` — a `number`-typed Decimal
 * validator, retired from this file at Wave B (the claim-bond port moved
 * `claimTaskManifest` onto the BigInt-exact `decimalStringArg` instead) and
 * reinstated here because `createTaskManifest`'s `rewardXrd`/`insuranceXrd`
 * are `number`s on BOTH sides of the parity guard — the server builder takes
 * `number`, so the client builder must too, or the cross-package byte-parity
 * assertion could never call them with the same arguments. Not a case for
 * `decimalStringArg`: nothing here is computed via BigInt subunit arithmetic
 * upstream (reward/insurance XRD are ordinary JS numbers the whole way from
 * the CLI's `--reward` flag), so a string-only validator would just move the
 * float-to-string conversion to the caller without fixing anything.
 */
function decimalArg(n: number, name: string, allowZero = false): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new Error(`Invalid ${name}: must be a finite number`);
  }
  if (n < 0) throw new Error(`Invalid ${name}: must not be negative`);
  if (!allowZero && n === 0) throw new Error(`Invalid ${name}: must be positive`);
  const s = String(n);
  if (s.includes('e') || s.includes('E')) {
    throw new Error(`Invalid ${name}: magnitude out of supported range`);
  }
  // Radix `Decimal` is fixed-point at 18dp, so anything finer is TRUNCATED on
  // chain — the manifest text would claim one amount and the ledger would move
  // another. Reachable from ordinary float arithmetic and does not look like an
  // error (e.g. `0.1 ** 6` prints as "0.0000010000000000000004", 22dp). Fail
  // closed rather than emit digits the chain will silently drop.
  const frac = s.split('.')[1] ?? '';
  if (frac.length > 18) {
    throw new Error(
      `Invalid ${name}: ${frac.length} decimal places exceeds the chain's 18 — ` +
        'pass an exact amount, never the result of float arithmetic'
    );
  }
  return s;
}

// Decimal arg that is ALREADY a string (as opposed to `decimalArg`, which
// takes a `number`) — for values computed exactly via BigInt arithmetic
// (`requiredBond`) that must reach the manifest without a float round-trip.
function decimalStringArg(s: string, name: string, allowZero = false): string {
  if (typeof s !== 'string' || !/^\d+(\.\d+)?$/.test(s)) {
    throw new Error(`Invalid ${name}: must be a plain non-negative decimal string`);
  }
  if (!allowZero && /^0(\.0*)?$/.test(s)) {
    throw new Error(`Invalid ${name}: must be positive`);
  }
  const frac = s.split('.')[1] ?? '';
  if (frac.length > 18) {
    throw new Error(`Invalid ${name}: ${frac.length} decimal places exceeds the chain's 18`);
  }
  return s;
}

// `assertCanonicalXrd` stood here — a tripwire against the XRD constant
// drifting (guild PR #107's "…stcfkr regression"). Retired at Wave B: it
// guarded `claimTaskManifest`'s ONE call site, which hardcoded XRD for the
// bond resource; that builder now takes `bondResource` from the live chain
// (the task's own `reward_token`, resolved by tx.ts's `resolveClaimBond`),
// so there is no local XRD constant left to drift. Its validator,
// `validateAddress(bondResource, 'resource_rdx')`, still fails closed on a
// malformed address — the guard moved from "matches this literal" to
// "shaped like a real resource address", which is what a caller-supplied
// value can actually be checked against.

// Strip characters that could break out of a manifest string literal — a
// byte-for-byte mirror of the guild-app sanitize() (defense-in-depth: the CLI
// validates the username charset strictly BEFORE this ever runs).
function sanitize(val: string): string {
  return val.replace(/["\\\n\r;]/g, '');
}

// ── builders ────────────────────────────────────────────────────────────────

/**
 * ⚠ NO PAIRING CHECK. A PAIRED personal agent must never sign this: its badge
 * comes with the owner's Fund & activate transaction, which aborts whole if the
 * name is already minted (docs/design/bring-your-agent.md §3.3). The guarded
 * path is mint.ts's `mintMemberBadge`; this is the raw builder under it.
 *
 * Self-mint a Guild Member badge: `public_mint(username)` on the BadgeManager
 * component (the same permissionless method radixguild.com/mint drives through
 * the wallet), depositing the badge NFT to the caller's account. Byte-for-byte
 * mirror of guild-app publicMintManifest — the local id it mints is
 * string-derived: `<guild_member_{username}>`.
 */
export function publicMintManifest(manager: string, username: string, account: string): string {
  const m = validateAddress(manager, 'component_rdx');
  const a = validateAddress(account, 'account_rdx');
  const u = sanitize(username);
  return `CALL_METHOD
  Address("${m}")
  "public_mint"
  "${u}"
;
CALL_METHOD
  Address("${a}")
  "deposit_batch"
  Expression("ENTIRE_WORKTOP")
;`;
}

/**
 * Worker (agent) claims an Open task: bonds `bondAmount` of `bondResource`
 * and presents its badge as a Proof; the Claim Receipt NFT lands in the
 * agent's account. For agents, `badgeResource`/`badgeLocalId` are the AGENT
 * badge.
 *
 * 🔴 WAVE B: the bond is no longer a flat XRD constant. `bondResource` /
 * `bondAmount` must be derived from the LIVE chain — the task's own
 * `reward_token` and the component's `required_bond(reward_amount,
 * claim_bond_pct, claim_bond_floor, claim_bond_cap, divisibility)` — never
 * hardcoded or guessed by a caller. `tx.ts`'s `resolveClaimBond` is that
 * derivation; this builder trusts whatever it is handed and only validates
 * shape. When `reward_token` happens to be XRD (the only token guild-app's
 * `create_task` has ever funded a task with) the emitted manifest is
 * byte-identical to the pre-Wave-B shape apart from the amount — same
 * resource, same instruction sequence.
 */
export function claimTaskManifest(
  escrowComponent: string,
  workerAccount: string,
  badgeResource: string,
  badgeLocalId: string,
  taskId: number,
  bondResource: string,
  bondAmount: string
): string {
  const c = validateAddress(escrowComponent, 'component_rdx');
  const a = validateAddress(workerAccount, 'account_rdx');
  const br = validateAddress(badgeResource, 'resource_rdx');
  const bid = validateLocalId(badgeLocalId, 'badgeLocalId');
  const tid = validatePositiveInt(taskId, 'taskId');
  const bondRes = validateAddress(bondResource, 'resource_rdx');
  const bond = decimalStringArg(bondAmount, 'bondAmount', true);
  return `CALL_METHOD
  Address("${a}")
  "withdraw"
  Address("${bondRes}")
  Decimal("${bond}")
;
TAKE_FROM_WORKTOP
  Address("${bondRes}")
  Decimal("${bond}")
  Bucket("claim_bond")
;
CALL_METHOD
  Address("${a}")
  "create_proof_of_non_fungibles"
  Address("${br}")
  Array<NonFungibleLocalId>(NonFungibleLocalId("${bid}"))
;
POP_FROM_AUTH_ZONE
  Proof("worker_proof")
;
CALL_METHOD
  Address("${c}")
  "claim_task"
  ${tid}u64
  Address("${a}")
  Proof("worker_proof")
  Bucket("claim_bond")
;
CALL_METHOD
  Address("${a}")
  "deposit_batch"
  Expression("ENTIRE_WORKTOP")
;`;
}

/**
 * Worker (agent) submits work for a Claimed task: presents the Claim Receipt
 * NFT as a Bucket (burned on-chain) + a 32-byte evidence hash + the brief hash.
 *
 * ⚠️ WAVE B: ABI 3 args → 4, and the claim bond NO LONGER returns here.
 *
 * `brief_hash` is the on-chain half of the keystone check (P4-3) — the
 * blueprint asserts it equals the `work_brief_hash` committed at `create_task`,
 * so an agent cannot submit against a brief that changed underneath it. Pass
 * the SAME canonical hash the task was created with; recompute it from the
 * task's stored fields, never from a locally-held copy that may have drifted.
 *
 * The bond is now held to settlement and credited to the PINNED worker account
 * (E1/E2) — an agent that expected a bond bucket on its worktop at submit will
 * find nothing, and that is correct. It arrives with the reward at collection.
 *
 * ✅ Wave B is the live component (cutover 2026-09-13), so this 4-arg form is
 * the one mainnet accepts; a pre-Wave-B component takes 3 args and rejects it.
 * Mirrors guild-app's builder, which the cross-package parity guard requires —
 * change both or neither.
 *
 * `claimReceiptId` is the receipt's integer local id (distinct from the task id
 * — resolve it from the agent account's NFTs).
 */
export function submitTaskManifest(
  escrowComponent: string,
  workerAccount: string,
  claimReceiptResource: string,
  claimReceiptId: number,
  taskId: number,
  evidenceHashHex: string,
  briefHashHex: string
): string {
  const c = validateAddress(escrowComponent, 'component_rdx');
  const a = validateAddress(workerAccount, 'account_rdx');
  const rr = validateAddress(claimReceiptResource, 'resource_rdx');
  const rid = intLocalId(claimReceiptId, 'claimReceiptId');
  const tid = validatePositiveInt(taskId, 'taskId');
  const ev = validateHashHex(evidenceHashHex, 'evidenceHash');
  const bh = validateHashHex(briefHashHex, 'briefHash');
  return `CALL_METHOD
  Address("${a}")
  "withdraw_non_fungibles"
  Address("${rr}")
  Array<NonFungibleLocalId>(NonFungibleLocalId("${rid}"))
;
TAKE_ALL_FROM_WORKTOP
  Address("${rr}")
  Bucket("claim_receipt")
;
CALL_METHOD
  Address("${c}")
  "submit_task"
  ${tid}u64
  Bucket("claim_receipt")
  Bytes("${ev}")
  Bytes("${bh}")
;
CALL_METHOD
  Address("${a}")
  "deposit_batch"
  Expression("ENTIRE_WORKTOP")
;`;
}

// ── Poster on-chain legs (P1-19) — byte-for-byte mirrors of guild-app's
// PULL-form builders (guild-app src/lib/manifests.ts § "Poster settlement
// legs"). PULL means each of these takes the Task Receipt as a PROOF and
// returns `()` — the blueprint credits entitlements internally, so none of
// them route money to an account or carry a `deposit_batch` sweep except
// `createTaskManifest` (which WITHDRAWS from the poster, so it alone sweeps
// any refund-relevant worktop residue back to the poster). See
// `withdrawPosterManifest`, below, for the collection half.

/**
 * Poster funds a new task: withdraws `rewardXrd` + `insuranceXrd` (XRD) from
 * the poster's own account and calls `create_task` on the escrow component;
 * the returned Task Receipt NFT deposits back to the poster. `arbiterFeePct`
 * is a plain decimal string ("0" at launch — no arbiter fee); `workBriefHashHex`
 * is the 32-byte `sha256(canonicalWorkBrief(...))` commitment (work-brief.ts) —
 * the SAME hash a later claim/submit is checked against, so it must be computed
 * from the DB-STORED title/description/terms, never from unsaved form state.
 *
 * `rewardXrd` / `insuranceXrd` are `number`, matching guild-app's builder
 * exactly (its own `decimalArg`, ported above) — `insuranceXrd` is expected to
 * come from `computeInsuranceXrd(rewardXrd)`, never a hand-picked value, or a
 * poster's funding leg could post insurance the app's own UI would never send.
 */
export function createTaskManifest(
  escrowComponent: string,
  posterAccount: string,
  rewardXrd: number,
  insuranceXrd: number,
  arbiterFeePct: string,
  workBriefHashHex: string
): string {
  const c = validateAddress(escrowComponent, 'component_rdx');
  const a = validateAddress(posterAccount, 'account_rdx');
  const xrd = MAINNET_XRD;
  const reward = decimalArg(rewardXrd, 'rewardXrd');
  const insurance = decimalArg(insuranceXrd, 'insuranceXrd');
  const fee = validateDecimal(arbiterFeePct, 'arbiterFeePct');
  const wbh = validateHashHex(workBriefHashHex, 'workBriefHash');
  return `CALL_METHOD
  Address("${a}")
  "withdraw"
  Address("${xrd}")
  Decimal("${reward}")
;
TAKE_FROM_WORKTOP
  Address("${xrd}")
  Decimal("${reward}")
  Bucket("reward")
;
CALL_METHOD
  Address("${a}")
  "withdraw"
  Address("${xrd}")
  Decimal("${insurance}")
;
TAKE_FROM_WORKTOP
  Address("${xrd}")
  Decimal("${insurance}")
  Bucket("insurance")
;
CALL_METHOD
  Address("${c}")
  "create_task"
  Address("${a}")
  Bucket("reward")
  Bucket("insurance")
  Decimal("${fee}")
  Bytes("${wbh}")
;
CALL_METHOD
  Address("${a}")
  "deposit_batch"
  Expression("ENTIRE_WORKTOP")
;`;
}

/**
 * Poster approves a Submitted task — PULL form. Presents the Task Receipt as a
 * PROOF; `approve_and_release` returns `()`, crediting reward→worker and
 * insurance→poster as entitlements. No worker account and no reward amount:
 * the blueprint routes both from state pinned on the task, which is the whole
 * point of pull — the caller cannot choose. The worker collects via
 * `withdrawWorkerManifest`; this client's poster side collects its own
 * insurance refund via `withdrawPosterManifest`.
 *
 * The receipt is NOT burned: under pull it remains the poster's entitlement
 * key for `withdraw_poster`.
 */
export function approveAndReleaseManifest(
  escrowComponent: string,
  posterAccount: string,
  receiptResource: string,
  taskId: number
): string {
  const c = validateAddress(escrowComponent, 'component_rdx');
  const a = validateAddress(posterAccount, 'account_rdx');
  const rr = validateAddress(receiptResource, 'resource_rdx');
  const rid = intLocalId(taskId, 'taskId');
  return `CALL_METHOD
  Address("${a}")
  "create_proof_of_non_fungibles"
  Address("${rr}")
  Array<NonFungibleLocalId>(NonFungibleLocalId("${rid}"))
;
POP_FROM_AUTH_ZONE
  Proof("receipt_proof")
;
CALL_METHOD
  Address("${c}")
  "approve_and_release"
  Proof("receipt_proof")
;`;
}

/**
 * Poster cancels an Open (unclaimed) task — PULL form. Proof-presented
 * receipt; `cancel_task` returns `()` and credits BOTH reward and insurance to
 * the poster's entitlement. Collect via `withdrawPosterManifest` (or append
 * that call in the same transaction).
 *
 * Valid ONLY while the task is still Open — once a worker has bonded a claim,
 * the chain rejects this and `cancelTaskAfterClaimManifest` is the recovery
 * path instead.
 */
export function cancelTaskManifest(
  escrowComponent: string,
  posterAccount: string,
  receiptResource: string,
  taskId: number
): string {
  const c = validateAddress(escrowComponent, 'component_rdx');
  const a = validateAddress(posterAccount, 'account_rdx');
  const rr = validateAddress(receiptResource, 'resource_rdx');
  const rid = intLocalId(taskId, 'taskId');
  return `CALL_METHOD
  Address("${a}")
  "create_proof_of_non_fungibles"
  Address("${rr}")
  Array<NonFungibleLocalId>(NonFungibleLocalId("${rid}"))
;
POP_FROM_AUTH_ZONE
  Proof("receipt_proof")
;
CALL_METHOD
  Address("${c}")
  "cancel_task"
  Proof("receipt_proof")
;`;
}

/**
 * Poster cancels a Claimed (not-yet-submitted) task — PULL form. Proof-presented
 * receipt; returns `()`. Reward + insurance credit to the poster, and the
 * worker's claim bond credits to the WORKER's own bond entitlement in full —
 * the blueprint deliberately leaves `claimer_badge_id` set so the worker can
 * still prove title and collect the bond via `withdrawWorkerManifest`. No
 * worker account and no bond amount here: both are state the blueprint already
 * holds, so the caller can neither short the bond nor sweep it.
 *
 * Valid ONLY while the task is Claimed (not yet submitted) — Open uses
 * `cancelTaskManifest`; Submitted onward can only be approved or disputed.
 */
export function cancelTaskAfterClaimManifest(
  escrowComponent: string,
  posterAccount: string,
  receiptResource: string,
  taskId: number
): string {
  const c = validateAddress(escrowComponent, 'component_rdx');
  const a = validateAddress(posterAccount, 'account_rdx');
  const rr = validateAddress(receiptResource, 'resource_rdx');
  const rid = intLocalId(taskId, 'taskId');
  const tid = validatePositiveInt(taskId, 'taskId');
  return `CALL_METHOD
  Address("${a}")
  "create_proof_of_non_fungibles"
  Address("${rr}")
  Array<NonFungibleLocalId>(NonFungibleLocalId("${rid}"))
;
POP_FROM_AUTH_ZONE
  Proof("receipt_proof")
;
CALL_METHOD
  Address("${c}")
  "cancel_task_by_poster_after_claim"
  ${tid}u64
  Proof("receipt_proof")
;`;
}

/**
 * Public, time-gated keeper call (Wave B stage 6). After a Submitted task's
 * review window lapses (`review_deadline`, pinned at `submit_task` from the
 * component's `review_window_secs`), ANYONE may call this to finalize the
 * release: delivered work cannot be ghosted by a poster who never reviews.
 * Pays EXACTLY what `approve_and_release` pays — reward + held claim bond to
 * the worker, insurance home to the poster — settled by CREDITING entitlements
 * inside the component, never by returning a bucket to the caller.
 *
 * One instruction, no accounts, no proof, no amounts, and no deposit leg:
 * nothing reaches the worktop, so there is nothing to sweep (same reasoning as
 * `autoResolveDisputeManifest` and `withdrawWorkerManifest`'s missing
 * `deposit_batch`). Emits the SAME `TaskReleasedEvent` as `approve_and_release`
 * (verified against escrow/scrypto/guild-marketplace-escrow/src/lib.rs) — so a
 * client confirming this leg to the Guild API uses `kind: 'approve'`, not a
 * distinct kind; there is no separate "timeout" confirm kind server-side, by
 * the same design that keeps the public `expire_claim` off the direct confirm
 * route (see `api.ts`'s `confirmEscrow` doc).
 */
export function releaseAfterReviewTimeoutManifest(escrowComponent: string, taskId: number): string {
  const c = validateAddress(escrowComponent, 'component_rdx');
  const tid = validatePositiveInt(taskId, 'taskId');
  return `CALL_METHOD
  Address("${c}")
  "release_after_review_timeout"
  ${tid}u64
;`;
}

// `heartbeatTaskManifest` stood here, byte-mirroring guild-app's
// `heartbeatManifest`. Both retire together under DB-3 (sitting 2026-08-06) —
// they have to: the parity guard in manifests.test.ts names the server export
// explicitly, so removing one twin alone fails the run loudly rather than
// leaving a builder that emits a call the PULL blueprint no longer answers.

/**
 * Poster or worker raises a dispute on a Submitted task. The worker presents the
 * Guild member badge they claimed with (agent path presents the AGENT badge); the
 * poster presents their Task Receipt. `evidenceHashHex` is optional (null → no
 * evidence). No funds move. Byte-for-byte mirror of guild-app raiseDisputeManifest.
 */
export function raiseDisputeManifest(
  escrowComponent: string,
  account: string,
  proofResource: string,
  proofLocalId: string,
  taskId: number,
  evidenceHashHex: string | null
): string {
  const c = validateAddress(escrowComponent, 'component_rdx');
  const a = validateAddress(account, 'account_rdx');
  const pr = validateAddress(proofResource, 'resource_rdx');
  const pid = validateLocalId(proofLocalId, 'proofLocalId');
  const tid = validatePositiveInt(taskId, 'taskId');
  const evidence =
    evidenceHashHex === null || evidenceHashHex === undefined
      ? 'Enum<0u8>()'
      : `Enum<1u8>(Bytes("${validateHashHex(evidenceHashHex, 'evidenceHash')}"))`;
  return `CALL_METHOD
  Address("${a}")
  "create_proof_of_non_fungibles"
  Address("${pr}")
  Array<NonFungibleLocalId>(NonFungibleLocalId("${pid}"))
;
POP_FROM_AUTH_ZONE
  Proof("party_proof")
;
CALL_METHOD
  Address("${c}")
  "raise_dispute"
  ${tid}u64
  Proof("party_proof")
  ${evidence}
;`;
}

/**
 * Public, time-gated keeper call — PULL form. After the auto-resolve window,
 * anyone may settle a Disputed task with the component's configured default
 * ruling (no arbiter fee). `auto_resolve_dispute` returns `()`: the blueprint
 * credits both entitlements internally, so a stranger calling this performs
 * the accounting and receives nothing — which is what makes a PUBLIC method
 * safe here. One instruction, no accounts, no amounts, and no deposit leg:
 * nothing reaches the worktop, so there is nothing to sweep (the same
 * reasoning as withdrawWorkerManifest's missing deposit_batch).
 */
export function autoResolveDisputeManifest(
  escrowComponent: string,
  taskId: number,
): string {
  const c = validateAddress(escrowComponent, 'component_rdx');
  const tid = validatePositiveInt(taskId, 'taskId');
  return `CALL_METHOD
  Address("${c}")
  "auto_resolve_dispute"
  ${tid}u64
;`;
}

/**
 * The ruling `auto_resolve_dispute` will apply, derived exactly as the blueprint
 * derives it (FavorDisputeRaiser maps the RAISER to PayWorker or RefundPoster;
 * SplitEvenly is always a 50/50 Split; ReturnToPoster is always RefundPoster).
 * Mirrors guild-app autoResolveRuling.
 *
 * REPORTING ONLY under pull: the manifest no longer routes by this — the
 * component applies its own default and credits entitlements internally.
 */
export function autoResolveRuling(
  autoDefault: 'FavorDisputeRaiser' | 'SplitEvenly' | 'ReturnToPoster',
  raisedBy: 'Poster' | 'Worker'
): 'PayWorker' | 'RefundPoster' | 'Split' {
  if (autoDefault === 'SplitEvenly') return 'Split';
  if (autoDefault === 'ReturnToPoster') return 'RefundPoster';
  return raisedBy === 'Worker' ? 'PayWorker' : 'RefundPoster';
}

/**
 * Worker (agent) collects a settled entitlement (PULL, redesign §5c). Presents
 * the claiming badge as a PROOF; the blueprint checks it is the claimer's
 * worker/agent badge and that its local id matches the stored `claimer_badge_id`.
 *
 * ⚠️ NO trailing `deposit_batch`, deliberately. `withdraw_worker` returns `()` —
 * the blueprint deposits into `task.worker_account`, the payee pin captured at
 * `claim_task`, from inside the method. Nothing reaches the worktop, so there is
 * nothing to sweep, and a sweep would imply the funds pass through the caller
 * when the whole point of pull is that they do not.
 *
 * Byte-for-byte mirror of guild-app withdrawWorkerManifest.
 */
export function withdrawWorkerManifest(
  escrowComponent: string,
  workerAccount: string,
  badgeResource: string,
  badgeLocalId: string,
  taskId: number
): string {
  const c = validateAddress(escrowComponent, 'component_rdx');
  const a = validateAddress(workerAccount, 'account_rdx');
  const br = validateAddress(badgeResource, 'resource_rdx');
  const bid = validateLocalId(badgeLocalId, 'badgeLocalId');
  const tid = validatePositiveInt(taskId, 'taskId');
  return `CALL_METHOD
  Address("${a}")
  "create_proof_of_non_fungibles"
  Address("${br}")
  Array<NonFungibleLocalId>(NonFungibleLocalId("${bid}"))
;
POP_FROM_AUTH_ZONE
  Proof("worker_proof")
;
CALL_METHOD
  Address("${c}")
  "withdraw_worker"
  ${tid}u64
  Proof("worker_proof")
;`;
}

/**
 * Poster collects a settled entitlement (PULL, redesign §5c). Presents the Task
 * Receipt as a PROOF — under pull the receipt is a persistent entitlement key,
 * not a one-shot token, so `approve_and_release` no longer burns it.
 *
 * The receipt's local id must be the integer task_id, and is DERIVED here rather
 * than passed in, so a caller cannot present one task's receipt against another.
 * Funds go to `task.poster`, pinned at `create_task`, so a stolen receipt cannot
 * redirect them.
 *
 * Byte-for-byte mirror of guild-app withdrawPosterManifest.
 */
export function withdrawPosterManifest(
  escrowComponent: string,
  posterAccount: string,
  taskReceiptResource: string,
  taskId: number
): string {
  const c = validateAddress(escrowComponent, 'component_rdx');
  const a = validateAddress(posterAccount, 'account_rdx');
  const rr = validateAddress(taskReceiptResource, 'resource_rdx');
  const tid = validatePositiveInt(taskId, 'taskId');
  const rid = intLocalId(taskId, 'taskId');
  return `CALL_METHOD
  Address("${a}")
  "create_proof_of_non_fungibles"
  Address("${rr}")
  Array<NonFungibleLocalId>(NonFungibleLocalId("${rid}"))
;
POP_FROM_AUTH_ZONE
  Proof("receipt_proof")
;
CALL_METHOD
  Address("${c}")
  "withdraw_poster"
  ${tid}u64
  Proof("receipt_proof")
;`;
}

/**
 * Public, time-gated cleanup. After a claim's deadline + grace passes, ANYONE
 * may expire the claim. DB-4 (sitting 2026-08-06): the forfeited bond SPLITS —
 * the method RETURNS a bucket with a min(1 XRD, bond) bounty for the caller,
 * remainder to the operator vault, never a poster credit. No auth, no proof,
 * no funds from the caller — but the caller receives, so the manifest deposits
 * the returned bucket to the caller's own account. Byte-for-byte mirror of
 * guild-app expireClaimManifest.
 */
export function expireClaimManifest(
  escrowComponent: string,
  callerAccount: string,
  taskId: number,
): string {
  const c = validateAddress(escrowComponent, 'component_rdx');
  const a = validateAddress(callerAccount, 'account_rdx');
  const tid = validatePositiveInt(taskId, 'taskId');
  return `CALL_METHOD
  Address("${c}")
  "expire_claim"
  ${tid}u64
;
CALL_METHOD
  Address("${a}")
  "deposit_batch"
  Expression("ENTIRE_WORKTOP")
;`;
}

// ── Self-funding (account → account, no escrow) ─────────────────────────────

/**
 * Plain XRD transfer, account → account. The ONE builder in this file that
 * never touches the escrow component: no badge, no receipt, nothing to
 * reconcile. It exists for P1-18 (task 76) — `doctor`/`onboard` compute and
 * print the funding target and the derived agent address, but funding itself
 * is deliberately manual for an operator-provisioned fleet (onboard.ts's
 * header). That is the wrong default for a genuinely AUTONOMOUS agent that
 * already controls XRD in some OTHER account it can sign for and has no
 * operator to ask — this is the scripted path for that case: build the
 * manifest here, sign and send it with the SAME `signAndSubmitManifest` every
 * other on-chain leg in this package uses (see the README's "Self-funding"
 * section for the full snippet).
 *
 * Byte-for-byte shape match with guild-app's `giftXrdManifest`
 * (`guild-app/src/lib/manifests.ts`) — `withdraw` → exact-amount
 * `TAKE_FROM_WORKTOP` → `try_deposit_or_abort` — which is itself the file's
 * only other builder that touches no component. `try_deposit_or_abort` (not
 * `deposit`) so the transaction fails visibly against a destination whose
 * deposit rules reject XRD, rather than the caller believing the funds
 * landed; mirrors the same operator sweep scripts use
 * (`guild-app/scripts/keeper-sweep.mjs`, `fleet-recycle.mjs`,
 * `sweep-env-key.mjs`). The method's second argument is
 * `Option<ResourceOrNonFungible>` (an authorized-depositor badge) — `None` is
 * `Enum<0u8>()`, the same encoding `raiseDisputeManifest` above uses for "no
 * evidence"; a self-funding transfer presents no such badge.
 *
 * Deliberately NOT cross-asserted against guild-app in manifests.test.ts's
 * parity guard (see that file's `PARITY_EXEMPT`): the web app never moves an
 * agent's own pre-existing XRD on its behalf, so there is no server builder
 * with the same contract to compare against — `giftXrdManifest` is the
 * closest analog, not a counterpart, and differs in the one place that
 * matters here (see the exemption comment).
 *
 * `xrdResource` is a required, caller-supplied parameter, not a local
 * constant — this file stopped trusting a local resource-address constant
 * for anything that signs real money at Wave B (see the retired
 * `assertCanonicalXrd` note above); pass `MAINNET_XRD` from `config.ts`
 * unless this client is re-pointed at a non-mainnet deployment.
 */
export function transferXrdManifest(args: {
  /** The account that already holds the XRD — MUST be able to sign for it. */
  from: string;
  /** Where the XRD should land — typically the derived agent account. */
  to: string;
  /** Plain decimal string ("50", "12.5") — never a float; see decimalStringArg. */
  amount: string;
  /** The XRD resource address (pass MAINNET_XRD from config.ts). */
  xrdResource: string;
}): string {
  const from = validateAddress(args.from, 'account_rdx');
  const to = validateAddress(args.to, 'account_rdx');
  if (from === to) {
    throw new Error('Invalid transfer: source and destination are the same account');
  }
  const xrd = validateAddress(args.xrdResource, 'resource_rdx');
  const amount = decimalStringArg(args.amount, 'amount');
  return `CALL_METHOD
  Address("${from}")
  "withdraw"
  Address("${xrd}")
  Decimal("${amount}")
;
TAKE_FROM_WORKTOP
  Address("${xrd}")
  Decimal("${amount}")
  Bucket("xrd")
;
CALL_METHOD
  Address("${to}")
  "try_deposit_or_abort"
  Bucket("xrd")
  Enum<0u8>()
;`;
}
