import { XRD_ADDRESS } from "./radix"
import { INSTANTIATE_SPEC } from "./generated/instantiate-spec"
import { isPositiveXrd, normalizeXrd } from "./xrd-decimal"

// Sanitize string values used in transaction manifests
function sanitize(val: string): string {
  return val.replace(/["\\\n\r;]/g, "");
}

// Free text that must survive verbatim inside a manifest string literal (the
// JSON in update_extra_data). sanitize() strips `"`, which wrote {"role":"mod"}
// on-chain as {role:mod}. Escape instead: backslash first, so an escape is never
// itself doubled. Newlines and `;` are still dropped, as sanitize() does.
function escapeManifestString(val: string): string {
  return val.replace(/[\n\r;]/g, "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// Validate Radix address format.
//
// The trailing `$` is load-bearing. Without it `[a-z0-9]{20,}` matches a valid
// prefix followed by ANYTHING — the match stops after 20 alnums — so a value like
// `account_rdx1aaaaaaaaaaaaaaaaaaaa")<newline><injected instructions>` passes and
// then flows verbatim into `Address("${addr}")`, breaking out of the string
// literal and appending attacker-chosen CALL_METHODs to a real money manifest.
// Real Radix addresses are all-lowercase bech32m to the end, so anchoring rejects
// only malformed/hostile input; the bytes emitted for any valid address are
// unchanged. (Ported from the agent-client copy, which was hardened first — the
// two must not drift.)
function validateAddress(addr: string, prefix: string): string {
  if (!new RegExp(`^${prefix}[a-z0-9]{20,}$`).test(addr)) {
    throw new Error(`Invalid ${prefix} address`);
  }
  return addr;
}

export function publicMintManifest(
  manager: string,
  username: string,
  account: string
): string {
  const m = validateAddress(manager, "component_rdx");
  const a = validateAddress(account, "account_rdx");
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

function adminProofPreamble(account: string, adminBadge: string, manager: string) {
  const a = validateAddress(account, "account_rdx");
  const m = validateAddress(manager, "component_rdx");
  const proof = `CALL_METHOD
  Address("${a}")
  "create_proof_of_amount"
  Address("${validateAddress(adminBadge, "resource_rdx")}")
  Decimal("1")
;`;
  return { m, proof };
}

export function updateTierManifest(
  manager: string, adminBadge: string, badgeId: string, newTier: string, account: string
): string {
  const { m, proof } = adminProofPreamble(account, adminBadge, manager);
  return `${proof}
CALL_METHOD
  Address("${m}")
  "update_tier"
  NonFungibleLocalId("${memberBadgeLocalId(badgeId)}")
  "${sanitize(newTier)}"
;`;
}

export function updateXpManifest(
  manager: string, adminBadge: string, badgeId: string, newXp: number, account: string
): string {
  const { m, proof } = adminProofPreamble(account, adminBadge, manager);
  const xp = Math.max(0, Math.floor(newXp));
  return `${proof}
CALL_METHOD
  Address("${m}")
  "update_xp"
  NonFungibleLocalId("${memberBadgeLocalId(badgeId)}")
  ${xp}u64
;`;
}

export function revokeBadgeManifest(
  manager: string, adminBadge: string, badgeId: string, reason: string, account: string
): string {
  const { m, proof } = adminProofPreamble(account, adminBadge, manager);
  return `${proof}
CALL_METHOD
  Address("${m}")
  "revoke_badge"
  NonFungibleLocalId("${memberBadgeLocalId(badgeId)}")
  "${sanitize(reason)}"
;`;
}

export function updateExtraDataManifest(
  manager: string, adminBadge: string, badgeId: string, extraData: string, account: string
): string {
  const { m, proof } = adminProofPreamble(account, adminBadge, manager);
  return `${proof}
CALL_METHOD
  Address("${m}")
  "update_extra_data"
  NonFungibleLocalId("${memberBadgeLocalId(badgeId)}")
  "${escapeManifestString(extraData)}"
;`;
}

// ============================================================
// ESCROW MANIFESTS
// ============================================================

// REWRITTEN 2026-06-08 against the deployed guild_marketplace_escrow blueprint
// `Escrow` (singleton, instance methods) — then package package_rdx1p4rmhkyp…,
// component component_rdx1cz9mh49… (both superseded by the vNext §8b cutover
// 2026-06-14; addresses come from config.ts / docs/ESCROW-ADDRESSES.md — the
// ABI shape is unchanged). The previous builders targeted the OLD
// constructor design (`CALL_FUNCTION <pkg> "GuildEscrow" "create_task" …`) with
// the wrong blueprint name + args, so every escrow op was a CommittedFailure.
// Each builder below mirrors the proven manifest shape in
// escrow/scrypto/guild-marketplace-escrow/tests/lib.rs (the on-chain ABI's
// reference). NB the app escrows XRD, so reward + insurance + claim_bond are all
// XRD and commingle on the worktop — funds bound for different recipients are
// split with TAKE_FROM_WORKTOP by EXACT amount, never TAKE_ALL.

// Escrow withdraws real XRD. Fail closed if XRD_ADDRESS ever drifts from the
// canonical mainnet value (the …stcfkr regression, PR #107) so a wrong constant
// can never produce a real-money manifest. The literal below is deliberately a
// SECOND, independently-written copy: comparing XRD_ADDRESS to itself would be
// tautological, so this is the one place a duplicate is the point rather than a
// smell. xrd-address-canonical.test.ts pins every other copy in src to this
// same value.
const MAINNET_XRD =
  "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd";
function assertCanonicalXrd(): string {
  if ((XRD_ADDRESS as string) !== MAINNET_XRD) {
    throw new Error(
      "XRD_ADDRESS is not canonical mainnet XRD — refusing to build an escrow manifest",
    );
  }
  return XRD_ADDRESS;
}

// Escrow task ids + claim-receipt ids are u64 integers on-chain → the manifest
// NonFungibleLocalId form is `#N#`.
function intLocalId(n: number, name: string): string {
  return `#${validatePositiveInt(n, name)}#`;
}

// Strict NonFungibleLocalId validator for ids supplied as strings (e.g. an
// external badge id whose form we don't control). Whitelists the four valid
// forms so nothing can break out of NonFungibleLocalId("…").
function validateLocalId(id: string, name: string): string {
  if (!/^(#\d+#|<[A-Za-z0-9_]+>|\{[0-9a-fA-F-]+\}|\[[0-9a-fA-F]+\])$/.test(id)) {
    throw new Error(`Invalid ${name}: not a valid NonFungibleLocalId`);
  }
  return id;
}

// A Guild Member badge's local id is a STRING id: `<guild_member_…>` on the
// ledger. The wallet rejects the bare `guild_member_…` form, which is what the
// /admin placeholder used to suggest, so a bare id is wrapped. Anything else
// must already be a valid local id. Throws before the wallet ever sees it.
function memberBadgeLocalId(id: string): string {
  const t = id.trim();
  return validateLocalId(/^[A-Za-z0-9_]+$/.test(t) ? `<${t}>` : t, "badge id");
}

// 32-byte commitment (work-brief / dispute-evidence Hash) → Bytes("<64 hex>").
// Scrypto `Hash` is a transparent [u8;32]; in manifest text that is the Array<U8>
// shorthand `Bytes(...)`. See tests/lib.rs create_task: `Hash([0u8; 32])`.
function validateHashHex(hex: string, name: string): string {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]{64}$/.test(h)) {
    throw new Error(`Invalid ${name}: must be a 32-byte hex string (64 chars)`);
  }
  return h.toLowerCase();
}

// Format a numeric XRD amount as a Decimal arg without float artifacts: uses the
// shortest round-trip string and rejects exponential notation. Callers must pass
// clean values (never the result of float arithmetic).
// NOTE: `BigInt(10) ** BigInt(18)` rather than `10n ** 18n` throughout this
// block. guild-app's tsconfig targets below ES2020, where bigint LITERALS are a
// compile error while the BigInt() constructor is fine. The arithmetic is
// identical; do not "tidy" these back to literals without moving the target,
// which is an app-wide build decision and not one this port should make.
/**
 * Exact Scrypto-Decimal scaling: an 18dp fixed-point decimal string → its
 * integer subunit count, so "10", "10.0" and "10.000000000000000000" compare
 * equal and no float ever touches the value.
 */
function scaleDecimal(v: string): bigint {
  const [whole, frac = ""] = v.split(".");
  return BigInt(whole + frac.padEnd(18, "0").slice(0, 18));
}

/** scaleDecimal's inverse, minimal form ("5000000000000000000" → "5"). */
function formatAttos(attos: bigint): string {
  if (attos < BigInt(0)) {
    throw new Error("formatAttos: negative amount — refusing to format as a manifest Decimal");
  }
  const ONE = BigInt(10) ** BigInt(18);
  const whole = attos / ONE;
  const frac = (attos % ONE).toString().padStart(18, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

/**
 * A faithful port of the blueprint's own `required_bond`:
 * `clamp(reward * pct, floor, cap)`, rounded DOWN to the bond token's
 * divisibility.
 *
 * Ported from packages/agent-client at the Wave B claim-bond port (2026-09-02)
 * and deliberately kept byte-equivalent to it — the two packages' claim
 * manifests are asserted byte-identical by a cross-package guard, and they can
 * only stay so if they compute the amount the same way.
 *
 * All arithmetic is in integer attos. Doing it in `number` would be wrong in a
 * way that looks right: a proportional bond is a product of two decimals, and
 * float residue below 1e-6 still prints in non-exponential form, so the
 * manifest would claim one amount while the ledger moved another.
 *
 * Rounds DOWN (toward zero), matching the blueprint. Rounding up would build a
 * manifest the component rejects.
 */
export function requiredBond(
  reward: string,
  pct: string,
  floor: string,
  cap: string,
  divisibility: number,
): string {
  if (!Number.isInteger(divisibility) || divisibility < 0 || divisibility > 18) {
    throw new Error(`Invalid divisibility: ${divisibility} (must be an integer in 0..18)`);
  }
  const ONE = BigInt(10) ** BigInt(18);
  const rewardAttos = scaleDecimal(reward);
  const pctAttos = scaleDecimal(pct);
  const floorAttos = scaleDecimal(floor);
  const capAttos = scaleDecimal(cap);
  if (rewardAttos < BigInt(0) || pctAttos < BigInt(0) || floorAttos < BigInt(0) || capAttos < BigInt(0)) {
    throw new Error("requiredBond: reward/pct/floor/cap must all be non-negative");
  }
  const rawAttos = (rewardAttos * pctAttos) / ONE;
  const clampedAttos =
    rawAttos < floorAttos ? floorAttos : rawAttos > capAttos ? capAttos : rawAttos;
  const divisor = BigInt(10) ** BigInt(18 - divisibility);
  return formatAttos(clampedAttos - (clampedAttos % divisor));
}

/**
 * `decimalArg`'s string-typed counterpart, ported from packages/agent-client at
 * the Wave B claim-bond port (2026-09-02). A proportional bond is computed in
 * exact 18dp integer arithmetic and arrives here as a STRING; routing it
 * through `decimalArg` would send it via `number` and reintroduce the binary
 * residue that function exists to reject.
 */
function decimalStringArg(s: string, name: string, allowZero = false): string {
  if (typeof s !== "string" || !/^\d+(\.\d+)?$/.test(s)) {
    throw new Error(`Invalid ${name}: must be a plain non-negative decimal string`);
  }
  if (!allowZero && /^0(\.0*)?$/.test(s)) {
    throw new Error(`Invalid ${name}: must be positive`);
  }
  const frac = s.split(".")[1] ?? "";
  if (frac.length > 18) {
    throw new Error(`Invalid ${name}: ${frac.length} decimal places exceeds the chain's 18`);
  }
  return s;
}

function decimalArg(n: number, name: string, allowZero = false): string {
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new Error(`Invalid ${name}: must be a finite number`);
  }
  if (n < 0) throw new Error(`Invalid ${name}: must not be negative`);
  if (!allowZero && n === 0) throw new Error(`Invalid ${name}: must be positive`);
  const s = String(n);
  if (s.includes("e") || s.includes("E")) {
    throw new Error(`Invalid ${name}: magnitude out of supported range`);
  }
  // Radix `Decimal` is fixed-point at 18dp, so anything finer is TRUNCATED on
  // chain — the manifest text would claim one amount and the ledger would move
  // another. This is reachable from ordinary float arithmetic and does not look
  // like an error: below ~1e-6 a double keeps non-exponential string form while
  // carrying its binary residue, e.g. 0.1 ** 6 is "0.0000010000000000000004",
  // which is 22 decimal places. Fail closed rather than emit digits the chain
  // will silently drop.
  const frac = s.split(".")[1] ?? "";
  if (frac.length > 18) {
    throw new Error(
      `Invalid ${name}: ${frac.length} decimal places exceeds the chain's 18 — ` +
        `pass an exact amount, never the result of float arithmetic`,
    );
  }
  return s;
}

/**
 * Poster funds a new task. Withdraws reward + insurance (XRD) and calls
 * create_task on the escrow COMPONENT; the returned Task Receipt NFT is
 * deposited back to the poster. `arbiterFeePct` ∈ [0, max_arbiter_fee_pct]
 * (deployed = 0.1); `workBriefHashHex` is a 32-byte commitment to the off-chain
 * brief. NB insurance must be ≥ min_insurance_fraction × reward or create_task
 * aborts (live Wave B component: max_arbiter_fee_pct 0.1, min_insurance_fraction
 * 0 — both owner-settable, re-read 2026-09-16).
 */
export function createTaskManifest(
  escrowComponent: string,
  posterAccount: string,
  rewardXrd: number,
  insuranceXrd: number,
  arbiterFeePct: string,
  workBriefHashHex: string,
): string {
  const c = validateAddress(escrowComponent, "component_rdx");
  const a = validateAddress(posterAccount, "account_rdx");
  const xrd = assertCanonicalXrd();
  const reward = decimalArg(rewardXrd, "rewardXrd");
  const insurance = decimalArg(insuranceXrd, "insuranceXrd");
  const fee = validateDecimal(arbiterFeePct, "arbiterFeePct");
  const wbh = validateHashHex(workBriefHashHex, "workBriefHash");
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
 * Worker claims an Open task. Posts a claim_bond and presents their Guild member
 * badge as a Proof. The returned Claim Receipt NFT (deposited to the worker) is
 * needed to submit.
 *
 * 🔴 WAVE B PORT, 2026-09-02. This took `claimBondXrd: number` and hardcoded XRD
 * as the bond resource, because the pre-Wave-B component carried a flat
 * `claim_bond_xrd` field. Wave B DELETES that field: the bond is proportional
 * (`clamp(reward * pct, floor, cap)`) and denominated in the task's own
 * `reward_token`. So the flat form would have sent 10 XRD where the blueprint
 * expects a computed amount of another resource, and EVERY claim from the site
 * would have reverted on `claim_bond amount does not match required` the moment
 * the swap ceremony completed. It fails safe — no funds move — but the product
 * cannot take a claim, and it would have looked like the ceremony caused it.
 *
 * The signature now matches packages/agent-client's builder exactly, which is
 * not cosmetic: that parity is asserted byte-for-byte by the cross-package
 * guard, and the guard had to be EXEMPTED for this builder while the two sides
 * disagreed. This port removes that exemption.
 *
 * `bondAmount` is a STRING and must come from `requiredBond` against LIVE chain
 * params — never a constant. There is no safe default: a guess is a reverted tx
 * (too small) or real money bonded on an unverified number (too large).
 */
export function claimTaskManifest(
  escrowComponent: string,
  workerAccount: string,
  badgeResource: string,
  badgeLocalId: string,
  taskId: number,
  bondResource: string,
  bondAmount: string,
): string {
  const c = validateAddress(escrowComponent, "component_rdx");
  const a = validateAddress(workerAccount, "account_rdx");
  const br = validateAddress(badgeResource, "resource_rdx");
  const bid = validateLocalId(badgeLocalId, "badgeLocalId");
  const tid = validatePositiveInt(taskId, "taskId");
  const bondRes = validateAddress(bondResource, "resource_rdx");
  const bond = decimalStringArg(bondAmount, "bondAmount", true);
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
 * Worker submits work for a Claimed task. Presents the Claim Receipt NFT as a
 * Bucket (burned on-chain) + a 32-byte evidence hash.
 *
 * ⚠️ WAVE B CHANGED THIS METHOD IN TWO WAYS, and both matter to a caller:
 *
 * 1. **ABI 3 args → 4.** `brief_hash` is new and is the on-chain half of the
 *    keystone check (P4-3): the blueprint asserts it equals the
 *    `work_brief_hash` committed at `create_task`. A worker cannot submit
 *    against a brief that has been swapped underneath them, and the app cannot
 *    quietly submit against a different brief than the one displayed. Pass the
 *    SAME canonical brief hash `create_task` committed — recompute it from the
 *    stored title/description/terms, never from unsaved form state.
 *
 * 2. **The claim bond is NO LONGER returned here.** It used to come back to the
 *    caller's worktop at submit; under Wave B (E1/E2) it is held to settlement
 *    and credited to the PINNED worker account. This manifest still sweeps the
 *    worktop, which is correct and now simply sweeps nothing — a worker's bond
 *    arrives with their reward when they collect, not at submit.
 *
 * ✅ Wave B IS the live component (cutover 2026-09-13), so this 4-arg form is
 * the one mainnet accepts — a committed 4-arg `submit_task` is on the ledger
 * (`txid_rdx1ku54hn9g67xlvct7j6kcwd5dp09mtuav379rxwaavvgrxucv8tzs5np0yx`,
 * 2026-09-15). One form only, following the precedent set when the push
 * builders were deleted at S3: gated against the scraped `lib.rs` ABI by
 * `manifest-abi-gate.test.ts`, with the rollback being a code change rather
 * than an env flip. A pre-Wave-B component takes 3 args and rejects this —
 * `scripts/launch-check.sh` compares the compiled shape against the baked
 * component's on-chain shape and is the gate that catches a build pointed at one.
 *
 * `claimReceiptId` is the integer local id of the worker's Claim Receipt
 * (distinct from task_id).
 */
export function submitTaskManifest(
  escrowComponent: string,
  workerAccount: string,
  claimReceiptResource: string,
  claimReceiptId: number,
  taskId: number,
  evidenceHashHex: string,
  briefHashHex: string,
): string {
  const c = validateAddress(escrowComponent, "component_rdx");
  const a = validateAddress(workerAccount, "account_rdx");
  const rr = validateAddress(claimReceiptResource, "resource_rdx");
  const rid = intLocalId(claimReceiptId, "claimReceiptId");
  const tid = validatePositiveInt(taskId, "taskId");
  const ev = validateHashHex(evidenceHashHex, "evidenceHash");
  const bh = validateHashHex(briefHashHex, "briefHash");
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

// ── Poster settlement legs — TWO forms each, selected by the escrow era ──────
//
// The three poster-side methods (approve_and_release, cancel_task,
// cancel_task_by_poster_after_claim) are where PUSH and PULL escrows disagree:
//
//   PUSH (the LIVE component, pre-P2): each method takes the Task Receipt as a
//   consumed Bucket and returns the vault contents to the CALLER's worktop, so
//   the manifest must route every leg itself — reward to the worker, bond to
//   the worker, remainder to the poster. Getting a leg wrong misroutes money
//   (that was H1); omitting one strands it.
//
//   PULL (the P2 blueprint, redesign §5c): each method takes the receipt as a
//   PROOF and returns `()`. The blueprint credits entitlements internally and
//   parties collect via withdraw_worker / withdraw_poster, each paid to a payee
//   pinned at claim/create time. NOTHING reaches the caller's worktop, so a
//   push-form manifest is not merely wrong — it is unbuildable against the
//   blueprint (BlueprintPayloadValidationError, proven by mainnet preview
//   2026-08-09), and every post-call routing instruction is dead plumbing.
//
// Every builder here is the PULL form and is gated against the scraped lib.rs
// ABI (manifest-abi-gate.test.ts). There is no era branch left: the `LegacyPush`
// builders were DELETED at S3, as this comment always said they would be, along
// with the FLAGS.escrowPull selection at their call sites.
//
// Rolling back to the push component is therefore a code change, not an env
// flip — which it effectively already was. `launch-check.sh` hard-fails when the
// compiled shape disagrees with the on-chain shape of the baked component, so
// flipping the flag alone never worked; and by S3 the retired push component
// held 0 XRD with the live pull component also drained (both Gateway-verified
// 2026-08-21), so a revert would have abandoned live state rather than restored
// service. Nothing was stranded in either direction.

/**
 * Poster approves a Submitted task — PULL form (canonical).
 *
 * Presents the Task Receipt as a PROOF; `approve_and_release` returns `()`,
 * crediting reward→worker and insurance→poster as entitlements. No worker
 * account and no reward amount: the blueprint routes both from state pinned on
 * the task, which is the whole point of pull — the caller cannot choose. The
 * worker collects via withdraw_worker (their payout is invisible until they
 * do; see escrow-withdraw.ts for the affordance).
 *
 * The receipt is NOT burned: under pull it remains the poster's entitlement
 * key for withdraw_poster. burn_task_receipt retires it once nothing is owed.
 */
export function approveAndReleaseManifest(
  escrowComponent: string,
  posterAccount: string,
  receiptResource: string,
  taskId: number,
): string {
  const c = validateAddress(escrowComponent, "component_rdx");
  const a = validateAddress(posterAccount, "account_rdx");
  const rr = validateAddress(receiptResource, "resource_rdx");
  const rid = intLocalId(taskId, "taskId");
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
 * Poster cancels an Open (unclaimed) task — PULL form (canonical).
 *
 * Proof-presented receipt; `cancel_task` returns `()` and credits reward AND
 * insurance to the poster's entitlement (both — measured by preview 2026-08-09;
 * the old "insurance forfeited" doc line was wrong). Collect via
 * withdraw_poster — or append that call in the same transaction, which is how
 * the rehearsal did it.
 */
export function cancelTaskManifest(
  escrowComponent: string,
  posterAccount: string,
  receiptResource: string,
  taskId: number,
): string {
  const c = validateAddress(escrowComponent, "component_rdx");
  const a = validateAddress(posterAccount, "account_rdx");
  const rr = validateAddress(receiptResource, "resource_rdx");
  const rid = intLocalId(taskId, "taskId");
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
 * Poster cancels a Claimed (not-yet-submitted) task — PULL form (canonical).
 *
 * Proof-presented receipt; returns `()`. Reward + insurance credit to the
 * poster, and the worker's claim bond credits to the WORKER's bond entitlement
 * — the blueprint deliberately leaves `claimer_badge_id` set so the worker can
 * still prove title and collect the bond in full via withdraw_worker (preview-
 * proven 2026-08-09). No worker account and no bond amount here: both are
 * state the blueprint already holds, so the caller can neither short the bond
 * nor sweep it.
 */
export function cancelTaskAfterClaimManifest(
  escrowComponent: string,
  posterAccount: string,
  receiptResource: string,
  taskId: number,
): string {
  const c = validateAddress(escrowComponent, "component_rdx");
  const a = validateAddress(posterAccount, "account_rdx");
  const rr = validateAddress(receiptResource, "resource_rdx");
  const rid = intLocalId(taskId, "taskId");
  const tid = validatePositiveInt(taskId, "taskId");
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
 * Poster or worker raises a dispute on a Submitted task. The poster presents
 * their Task Receipt as a Proof; the worker presents the Guild member badge they
 * claimed with. `evidenceHashHex` is optional (null → no evidence). No funds
 * move; resolution (arbiter / auto-resolve keeper) is a separate, money-routing
 * builder — see the deferred resolve-dispute follow-up.
 */
export function raiseDisputeManifest(
  escrowComponent: string,
  account: string,
  proofResource: string,
  proofLocalId: string,
  taskId: number,
  evidenceHashHex: string | null,
): string {
  const c = validateAddress(escrowComponent, "component_rdx");
  const a = validateAddress(account, "account_rdx");
  const pr = validateAddress(proofResource, "resource_rdx");
  const pid = validateLocalId(proofLocalId, "proofLocalId");
  const tid = validatePositiveInt(taskId, "taskId");
  const evidence =
    evidenceHashHex === null || evidenceHashHex === undefined
      ? "Enum<0u8>()"
      : `Enum<1u8>(Bytes("${validateHashHex(evidenceHashHex, "evidenceHash")}"))`;
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

// `heartbeatManifest` stood here. Removed with the blueprint method it called
// (DB-3, sitting 2026-08-06). Its client twin `heartbeatTaskManifest` goes in
// the same commit — the cross-package parity guard requires it.

/**
 * Worker collects a settled entitlement (PULL, redesign §5c).
 *
 * Presents the claiming badge as a PROOF — never a Bucket. The blueprint checks
 * the resource is the claimer's worker/agent badge and that its local id matches
 * the stored `claimer_badge_id`, so a badge that did not claim this task cannot
 * withdraw against it.
 *
 * ⚠️ NO trailing `deposit_batch`, and that is not an omission. `withdraw_worker`
 * returns `()`: the blueprint deposits into `task.worker_account` — the payee pin
 * captured at `claim_task` and never chosen by the caller — from inside the
 * method, because Scrypto gives a blueprint no way to constrain where a RETURNED
 * bucket goes. Nothing reaches the worktop, so there is nothing to sweep, and
 * adding a sweep would imply the funds pass through the caller when the entire
 * point of pull is that they do not.
 *
 * Two instructions only — present a proof, call the method — because nothing
 * comes back to sweep.
 */
export function withdrawWorkerManifest(
  escrowComponent: string,
  workerAccount: string,
  badgeResource: string,
  badgeLocalId: string,
  taskId: number,
): string {
  const c = validateAddress(escrowComponent, "component_rdx");
  const a = validateAddress(workerAccount, "account_rdx");
  const br = validateAddress(badgeResource, "resource_rdx");
  const bid = validateLocalId(badgeLocalId, "badgeLocalId");
  const tid = validatePositiveInt(taskId, "taskId");
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
 * Poster collects a settled entitlement (PULL, redesign §5c).
 *
 * Presents the Task Receipt as a PROOF, not a Bucket — under pull the receipt
 * stops being a one-shot token and becomes a persistent entitlement key, so
 * `approve_and_release` no longer burns it and the poster still needs it here.
 * `burn_task_receipt` retires it once nothing is owed.
 *
 * The receipt's local id must be the integer `task_id`; the blueprint asserts
 * exactly that and panics on a non-integer id. Funds go to `task.poster`, pinned
 * at `create_task`, so even a stolen receipt cannot redirect them — which is
 * what makes presenting a transferable credential safe here.
 *
 * No trailing `deposit_batch`, for the same reason as the worker builder.
 */
export function withdrawPosterManifest(
  escrowComponent: string,
  posterAccount: string,
  taskReceiptResource: string,
  taskId: number,
): string {
  const c = validateAddress(escrowComponent, "component_rdx");
  const a = validateAddress(posterAccount, "account_rdx");
  const rr = validateAddress(taskReceiptResource, "resource_rdx");
  const tid = validatePositiveInt(taskId, "taskId");
  // The receipt's local id IS the task id — derived, never passed in, so a
  // caller cannot present a receipt for one task against another.
  const rid = intLocalId(taskId, "taskId");
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
 * Public, time-gated cleanup. After a claim's deadline + grace passes, anyone
 * may expire it, while it is still Claimed. DB-4 (sitting 2026-08-06): the
 * forfeited bond SPLITS — the method RETURNS a bucket with the caller's bounty,
 * `expire_bounty_pct` of the bond (0.1 live), rounded down (the keeper is
 * watch-only; someone must be paid to call this), remainder to the
 * operator vault, and NEVER a poster credit (that shape was farmable). No auth
 * and no funds from the caller — but the caller now receives, so the manifest
 * deposits the returned bucket to the caller's own account.
 */
export function expireClaimManifest(
  escrowComponent: string,
  callerAccount: string,
  taskId: number,
): string {
  const c = validateAddress(escrowComponent, "component_rdx");
  const a = validateAddress(callerAccount, "account_rdx");
  const tid = validatePositiveInt(taskId, "taskId");
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

/**
 * Deposit a settled entitlement into the party's PINNED account, on anyone's call.
 *
 * 🔴 THE RECOVERY PATH THAT HAD NO SURFACE. PULL made collection a separate
 * signed step, which closed BUG-7 and created a failure with no remedy: a payee
 * who never collects — or who has LOST the credential that lets them — leaves
 * settled funds sitting in the component forever. There is no admin override
 * anywhere in the blueprint, and both the claim receipt and the task receipt are
 * permanently transferable bearer instruments, so a lost one is simply gone.
 *
 * The blueprint's `push_entitlement` exists for exactly this. It shipped with NO
 * manifest builder and NO caller — reachable only from a CLI — which is the same
 * gap `expire_claim` had: a recovery the blueprint deliberately made
 * permissionless, available to nobody.
 *
 * 🔑 SAFE TO LEAVE UNAUTH'D, and the reason is structural rather than a check:
 * there is no destination ARGUMENT. The blueprint reads the pin from its own
 * state (`worker_account` from claim_task, `poster` from create_task), exactly
 * as the withdraw paths do. A hostile caller's best available outcome is paying
 * a stranger their own money and paying the network fee to do it. That is the
 * precise distinction from the caller-routed settlement PULL removed: this
 * pushes to a pin, it does not route to a caller.
 *
 * `party` is SBOR-encoded by INDEX from `EntitledParty { Worker, Poster }` —
 * Worker is `Enum<0u8>()`, Poster is `Enum<1u8>()`. Appending to that enum is
 * safe; reordering silently re-points every manifest written against it.
 *
 * ✅ Deployed: `push_entitlement` is in the live Wave B package's blueprint
 * interface (Gateway `/state/package/page/blueprints`, read 2026-09-16). It
 * deposits through the same `deposit_both_lanes` as the withdraw paths, so the
 * pinned payee must still be an Account. Gated by `manifest-abi-gate.test.ts`.
 */
export function pushEntitlementManifest(
  escrowComponent: string,
  taskId: number,
  party: "worker" | "poster",
): string {
  const c = validateAddress(escrowComponent, "component_rdx");
  const tid = validatePositiveInt(taskId, "taskId");
  const variant = party === "worker" ? 0 : 1;
  return `CALL_METHOD
  Address("${c}")
  "push_entitlement"
  ${tid}u64
  Enum<${variant}u8>()
;`;
}

// ── Gifts (/gift) ────────────────────────────────────────────────────────────

/**
 * Plain XRD transfer, account → account. The ONLY builder here that touches no
 * component: a gift is a direct send to bigdev's account, with no escrow, no
 * receipt, and nothing to reconcile — it buys the donor nothing and creates no
 * obligation. `toAccount` comes from gift.ts, which resolves it from env and
 * refuses to yield anything that fails a bech32m checksum; this never invents a
 * destination and never falls back to one.
 *
 * try_deposit_or_abort (not deposit) so the tx fails visibly against an account
 * whose deposit rules reject XRD, rather than the donor believing it landed.
 * The exact-amount TAKE_FROM_WORKTOP is the file convention (see the escrow
 * note above); nothing commingles on this worktop, but "take exactly what was
 * withdrawn" is the shape that stays correct if a leg is ever added.
 */
export function giftXrdManifest(
  fromAccount: string,
  toAccount: string,
  amountXrd: number,
): string {
  const from = validateAddress(fromAccount, "account_rdx");
  const to = validateAddress(toAccount, "account_rdx");
  if (from === to) {
    throw new Error("Invalid gift: sender and recipient are the same account");
  }
  const xrd = assertCanonicalXrd();
  const amt = decimalArg(amountXrd, "amountXrd");
  return `CALL_METHOD
  Address("${from}")
  "withdraw"
  Address("${xrd}")
  Decimal("${amt}")
;
TAKE_FROM_WORKTOP
  Address("${xrd}")
  Decimal("${amt}")
  Bucket("gift")
;
CALL_METHOD
  Address("${to}")
  "try_deposit_or_abort"
  Bucket("gift")
  Enum<0u8>()
;`;
}

/**
 * Owner-only: whitelist a reward token (Track-B step 2 — register XRD). Requires
 * the escrow Owner Badge proof. `minAmount` is the per-token minimum reward.
 * add_accepted_token is restrict_to:[OWNER].
 */
export function registerAcceptedTokenManifest(
  escrowComponent: string,
  ownerAccount: string,
  ownerBadgeResource: string,
  tokenResource: string,
  minAmount: number,
): string {
  const c = validateAddress(escrowComponent, "component_rdx");
  const oa = validateAddress(ownerAccount, "account_rdx");
  const ob = validateAddress(ownerBadgeResource, "resource_rdx");
  const tr = validateAddress(tokenResource, "resource_rdx");
  const min = decimalArg(minAmount, "minAmount", true);
  return `CALL_METHOD
  Address("${oa}")
  "create_proof_of_amount"
  Address("${ob}")
  Decimal("1")
;
CALL_METHOD
  Address("${c}")
  "add_accepted_token"
  Address("${tr}")
  Decimal("${min}")
;`;
}

// ── Dispute resolution (arbiter + public auto-resolve) — PULL, redesign §5c ──
//
// Neither finalize method hands the parties' money to the caller any more.
// `resolve_dispute` credits the worker + poster entitlements internally and
// returns only `(arbiter_badge, arbiter_fee)` — the caller's own badge back,
// plus the fee they have just proven themselves entitled to.
// `auto_resolve_dispute` returns `()` outright. Parties collect via
// withdraw_worker / withdraw_poster, each paid to a payee pinned at
// claim/create time. So these builders emit NO routing legs: nothing reaches
// the worktop for the caller to route, and a TAKE_FROM_WORKTOP after either
// call is not merely dead plumbing — it fails the whole transaction against an
// empty worktop whenever a share is non-zero. (The push-era builders that DID
// route — and the H1 share arithmetic that came with them — died with the push
// blueprint's dispute lane; see git history for those shapes.)
//
// Credit semantics, for reference (lib.rs credit_split_for_parties):
//   resolve_dispute — ARBITER-ruled: one ruling governs reward AND remaining
//     insurance (insurance minus the arbiter fee).
//   auto_resolve_dispute — NOBODY judged: the default ruling governs the
//     REWARD only; the insurance premium always returns to the poster.
// The app never recomputes these amounts — they arrive in settlement events.

export type DisputeRuling =
  | { kind: "PayWorker" }
  | { kind: "RefundPoster" }
  | { kind: "Split"; workerPct: string; posterPct: string }

function encodeRuling(ruling: DisputeRuling): string {
  switch (ruling.kind) {
    case "PayWorker":
      return "Enum<0u8>()"
    case "RefundPoster":
      return "Enum<1u8>()"
    case "Split":
      return `Enum<2u8>(Decimal("${validateDecimal(ruling.workerPct, "workerPct")}"), Decimal("${validateDecimal(ruling.posterPct, "posterPct")}"))`
  }
}

/**
 * Arbiter resolves a Disputed task — PULL form, PROOF auth (Wave B).
 *
 * Presents the arbiter badge as a PROOF — the Wave B badge is
 * non-transferable, so a Bucket form is physically uncallable against it
 * (the pre-Wave-B builder here was exactly that, caught at ceremony prep).
 * `resolve_dispute` decodes the badge's ArbiterBadgeData for the L6(c)
 * self-dealing guard, credits the worker + poster entitlements internally,
 * and returns only the arbiter fee; the trailing deposit_batch banks it for
 * the arbiter, who has just proven custody of the badge that entitles them —
 * caller and payee are the same party, which is what makes the direct return
 * safe. No party accounts and no share amounts in the signature: the caller
 * cannot route other people's money under pull.
 */
export function resolveDisputeManifest(
  escrowComponent: string,
  arbiterAccount: string,
  arbiterBadgeResource: string,
  arbiterBadgeLocalId: string,
  taskId: number,
  ruling: DisputeRuling,
): string {
  const c = validateAddress(escrowComponent, "component_rdx")
  const a = validateAddress(arbiterAccount, "account_rdx")
  const br = validateAddress(arbiterBadgeResource, "resource_rdx")
  const bid = validateLocalId(arbiterBadgeLocalId, "arbiterBadgeLocalId")
  const tid = validatePositiveInt(taskId, "taskId")
  const rulingEnum = encodeRuling(ruling)
  // PROOF, not Bucket — Wave B. The ceremony badge is NON-TRANSFERABLE
  // (withdrawer DenyAll, forever), so the old withdraw_non_fungibles +
  // Bucket form could never execute against it: the blueprint moved to a
  // Proof and this builder moved with it. Proof creation is not a
  // withdrawal, so it works under DenyAll. The only thing on the worktop
  // afterwards is the arbiter fee.
  return `CALL_METHOD
  Address("${a}")
  "create_proof_of_non_fungibles"
  Address("${br}")
  Array<NonFungibleLocalId>(NonFungibleLocalId("${bid}"))
;
POP_FROM_AUTH_ZONE
  Proof("arbiter_proof")
;
CALL_METHOD
  Address("${c}")
  "resolve_dispute"
  ${tid}u64
  Proof("arbiter_proof")
  ${rulingEnum}
;
CALL_METHOD
  Address("${a}")
  "deposit_batch"
  Expression("ENTIRE_WORKTOP")
;`
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
  const c = validateAddress(escrowComponent, "component_rdx")
  const tid = validatePositiveInt(taskId, "taskId")
  return `CALL_METHOD
  Address("${c}")
  "auto_resolve_dispute"
  ${tid}u64
;`
}

/**
 * Wave B stage 6 — public, time-gated keeper call. After a Submitted task's
 * review window lapses (`review_deadline`, pinned at submit_task from the
 * component's `review_window_secs`), anyone may call this to finalize the
 * release: "on Guild, delivered work cannot be ghosted." Pays EXACTLY what
 * `approve_and_release` pays — reward + held claim bond to the worker,
 * insurance home to the poster — settled by CREDITING entitlements inside the
 * component (PULL), never by returning a bucket to the caller. One
 * instruction, no accounts, no amounts, and no deposit leg: nothing reaches
 * the worktop, so there is nothing to sweep (same reasoning as
 * autoResolveDisputeManifest above and withdrawWorkerManifest's missing
 * deposit_batch).
 */
export function releaseAfterReviewTimeoutManifest(
  escrowComponent: string,
  taskId: number,
): string {
  const c = validateAddress(escrowComponent, "component_rdx")
  const tid = validatePositiveInt(taskId, "taskId")
  return `CALL_METHOD
  Address("${c}")
  "release_after_review_timeout"
  ${tid}u64
;`
}

/**
 * The ruling `auto_resolve_dispute` will apply, derived exactly as the blueprint
 * derives it (lib.rs: FavorDisputeRaiser maps the RAISER to PayWorker or
 * RefundPoster; SplitEvenly is always a 50/50 Split; ReturnToPoster is always
 * RefundPoster).
 *
 * REPORTING ONLY under pull: the manifest no longer routes by this — the
 * component applies its own default and credits entitlements internally. The
 * keeper's alert, poster-harness's log and gate1-e2e's payout expectations
 * still derive what WILL happen from it, so it must keep matching lib.rs.
 */
export function autoResolveRuling(
  autoDefault: "FavorDisputeRaiser" | "SplitEvenly" | "ReturnToPoster",
  raisedBy: "Poster" | "Worker",
): "PayWorker" | "RefundPoster" | "Split" {
  if (autoDefault === "SplitEvenly") return "Split"
  if (autoDefault === "ReturnToPoster") return "RefundPoster"
  return raisedBy === "Worker" ? "PayWorker" : "RefundPoster"
}

// ── Agent Badge (recall-based kill switch) ──

function validateDecimal(val: string, name: string): string {
  if (!/^\d+(\.\d+)?$/.test(val)) {
    throw new Error(`Invalid ${name}: must be a non-negative decimal string`);
  }
  return val;
}

function validatePositiveInt(n: number, name: string): number {
  // > MAX_SAFE_INTEGER: Number.isInteger stays true but the value is no longer
  // exactly representable, so `${n}u64` would emit a DIFFERENT id than intended
  // (2^53+1 → 2^53). Task/receipt ids are on-chain u64; refuse anything past the
  // safe range rather than sign a manifest against the wrong task. (Ported from
  // the agent-client copy — the two must not drift.)
  if (!Number.isInteger(n) || n <= 0 || n > Number.MAX_SAFE_INTEGER) {
    throw new Error(`Invalid ${name}: must be a positive integer`);
  }
  return n;
}

/**
 * Build a manifest that mints a new AgentBadge and deposits it to the agent's account.
 *
 * Owner-gated: requires the operator's owner-badge proof in the auth zone.
 * The badge_id is allocated server-side by the controller (monotonic next_badge_id)
 * and reported in the AgentBadgeMintedEvent emitted by the TX.
 */
export function mintAgentBadgeManifest(
  controllerComponent: string,
  ownerAccount: string,
  ownerBadgeResource: string,
  agentAccount: string,
  agentName: string,
  agentRadixAddress: string,
  spendingLimitPerTask: string,
  dailySpendingCap: string,
): string {
  const c = validateAddress(controllerComponent, "component_rdx");
  const oa = validateAddress(ownerAccount, "account_rdx");
  const ob = validateAddress(ownerBadgeResource, "resource_rdx");
  // The agent account is NOT the signer: instruction 0 proves the OWNER badge, so
  // the owner signs. Account::deposit_batch is _owner_-restricted, so the trailing
  // leg must use the public try_deposit_batch_or_abort or the whole tx reverts with
  // an AuthError (verified read-only against mainnet /transaction/preview) — the
  // badge is never delivered and the fee burns.
  const aa = validateAddress(agentAccount, "account_rdx");
  const n = sanitize(agentName);
  if (!n) throw new Error("agent_name cannot be empty after sanitization");
  const ra = validateAddress(agentRadixAddress, "account_rdx");
  const slpt = validateDecimal(spendingLimitPerTask, "spending_limit_per_task");
  const dsc = validateDecimal(dailySpendingCap, "daily_spending_cap");
  return `CALL_METHOD
  Address("${oa}")
  "create_proof_of_amount"
  Address("${ob}")
  Decimal("1")
;
CALL_METHOD
  Address("${c}")
  "mint_agent_badge"
  "${n}"
  "${ra}"
  Decimal("${slpt}")
  Decimal("${dsc}")
;
CALL_METHOD
  Address("${aa}")
  "try_deposit_batch_or_abort"
  Expression("ENTIRE_WORKTOP")
  Enum<0u8>()
;`;
}

/**
 * Bring Your Agent — the ONE owner-signed transaction that activates an agent
 * (docs/design/bring-your-agent.md §3.4): withdraw the float from the owner's
 * account, mint the agent's Member badge by name, and deposit both into the
 * agent's own account.
 *
 * - `try_deposit_batch_or_abort`, never `deposit_batch`: the agent account is
 *   not a signer here, and `deposit_batch` is owner-restricted — it AuthErrors
 *   for a non-signer target (the reasoning in mintAgentBadgeManifest above).
 *   Do not copy publicMintManifest, whose `deposit_batch` is safe only because
 *   signer == target there.
 * - No `lock_fee`: the wallet adds it from the owner's account, so the agent
 *   receives the whole float.
 * - `labelNorm` is the ALREADY-normalised badge name (`[a-z0-9_]{1,51}` — a
 *   string local id cannot hold '-' and caps at 64 bytes including the
 *   `guild_member_` prefix; see src/lib/agent-label.ts). Refused, never
 *   filtered: the name in the manifest must be exactly the one the app checked.
 * - Previewed keyless on mainnet 2026-09-24: succeeded with a fresh virtual
 *   account as the agent (+200 XRD, +1 badge); the same manifest with a taken
 *   name failed `NonFungibleAlreadyExists` with no resource changes.
 */
export function pairAgentManifest(
  manager: string,
  ownerAccount: string,
  agentAccount: string,
  labelNorm: string,
  floatXrd: string,
): string {
  const m = validateAddress(manager, "component_rdx");
  const owner = validateAddress(ownerAccount, "account_rdx");
  const agent = validateAddress(agentAccount, "account_rdx");
  if (owner === agent) {
    throw new Error("Invalid pairing: the owner and the agent must be different accounts");
  }
  if (!/^[a-z0-9_]{1,51}$/.test(labelNorm)) {
    throw new Error("Invalid labelNorm: must be the normalised badge name, [a-z0-9_]{1,51}");
  }
  if (typeof floatXrd !== "string" || !isPositiveXrd(floatXrd)) {
    throw new Error("Invalid floatXrd: must be a positive decimal string of at most 18 dp");
  }
  const xrd = assertCanonicalXrd();
  const amount = normalizeXrd(floatXrd);
  return `CALL_METHOD
  Address("${owner}")
  "withdraw"
  Address("${xrd}")
  Decimal("${amount}")
;
CALL_METHOD
  Address("${m}")
  "public_mint"
  "${labelNorm}"
;
CALL_METHOD
  Address("${agent}")
  "try_deposit_batch_or_abort"
  Expression("ENTIRE_WORKTOP")
  Enum<0u8>()
;`;
}

/**
 * Build a manifest that recalls an AgentBadge from the holding vault and burns it.
 *
 * Owner-gated via the recall_roles config on the resource (require(owner_badge)).
 * `agentVaultAddress` is the internal_vault_rdx address of the vault holding the
 * agent's badge — discover via Gateway /state/entity/details on the agent's account
 * before calling this builder.
 *
 * After the TX commits the agent's vault is empty; clients that check badge presence
 * will fail closed.
 */
export function recallAgentBadgeManifest(
  agentBadgeResource: string,
  agentVaultAddress: string,
  ownerAccount: string,
  ownerBadgeResource: string,
  badgeId: number,
): string {
  const r = validateAddress(agentBadgeResource, "resource_rdx");
  const v = validateAddress(agentVaultAddress, "internal_vault_rdx");
  const oa = validateAddress(ownerAccount, "account_rdx");
  const ob = validateAddress(ownerBadgeResource, "resource_rdx");
  const id = validatePositiveInt(badgeId, "badgeId");
  return `CALL_METHOD
  Address("${oa}")
  "create_proof_of_amount"
  Address("${ob}")
  Decimal("1")
;
RECALL_NON_FUNGIBLES_FROM_VAULT
  Address("${v}")
  Array<NonFungibleLocalId>(NonFungibleLocalId("#${id}#"))
;
TAKE_ALL_FROM_WORKTOP
  Address("${r}")
  Bucket("recalled_badge")
;
BURN_RESOURCE
  Bucket("recalled_badge")
;`;
}

/**
 * Build the one-shot deployment manifest for the AgentBadgeController.
 *
 * Publishes the package (caller supplies WASM + RPD bytes via tooling) and
 * instantiates the controller. Owner badge gets deposited to `ownerAccount`.
 *
 * NOTE: this builder only emits the call_function + deposit. The publish step
 * is handled by Radix Engine Toolkit / dApp toolkit since it requires raw
 * bytes that can't go in a sanitized string.
 */
export function instantiateAgentBadgeControllerManifest(
  packageAddress: string,
  ownerAccount: string,
): string {
  const p = validateAddress(packageAddress, "package_rdx");
  const oa = validateAddress(ownerAccount, "account_rdx");
  return `CALL_FUNCTION
  Address("${p}")
  "AgentBadgeController"
  "instantiate"
;
CALL_METHOD
  Address("${oa}")
  "deposit_batch"
  Expression("ENTIRE_WORKTOP")
;`;
}

// ============================================================
// CV2 GOVERNANCE MANIFESTS  (Phase 3a — ported from guild-public)
// ============================================================
//
// Byte-faithful port of guild-public's production-proven on-chain voting
// builders (guild-public/guild-app/src/lib/manifests.ts). The emitted manifest
// strings are identical to the live ones. Free-text governance inputs
// (title / description / options) go through sanitizeGov() below — a STRICTER
// sanitizer (also strips ` { } < >) that matches guild-public's voting
// sanitizer. This file's escrow/badge sanitize() is weaker; do NOT route
// governance text through it.
//
// The CV2 component address is NOT hardcoded here — the caller passes
// CV2_COMPONENT from @/lib/config.

// Stricter sanitizer for free-text governance inputs (matches guild-public's
// voting sanitizer). Strips quotes, backticks, braces, angle brackets,
// backslash, newlines, CR and semicolons to prevent manifest injection via a
// proposal title / description / option.
function sanitizeGov(val: string): string {
  return val.replace(/["`{}\\\n\r;<>]/g, "");
}

export function makeTemperatureCheckManifest(
  component: string,
  account: string,
  title: string,
  shortDescription: string,
  description: string,
  options: string[],
): string {
  const c = validateAddress(component, "component_rdx");
  const a = validateAddress(account, "account_rdx");
  const t = sanitizeGov(title);
  const sd = sanitizeGov(shortDescription);
  const desc = sanitizeGov(description);
  const opts = options.map(o => `Tuple("${sanitizeGov(o)}")`).join(", ");
  return `CALL_METHOD
  Address("${c}")
  "make_temperature_check"
  Address("${a}")
  Tuple(
    "${t}",
    "${sd}",
    "${desc}",
    Array<Tuple>(${opts}),
    Array<String>(),
    Enum<0u8>()
  )
;
CALL_METHOD
  Address("${a}")
  "deposit_batch"
  Expression("ENTIRE_WORKTOP")
;`;
}

export function voteOnTemperatureCheckManifest(
  component: string,
  account: string,
  temperatureCheckId: number,
  vote: "for" | "against",
): string {
  const c = validateAddress(component, "component_rdx");
  const a = validateAddress(account, "account_rdx");
  const voteEnum = vote === "for" ? "Enum<0u8>()" : "Enum<1u8>()";
  return `CALL_METHOD
  Address("${c}")
  "vote_on_temperature_check"
  Address("${a}")
  ${temperatureCheckId}u64
  ${voteEnum}
;
CALL_METHOD
  Address("${a}")
  "deposit_batch"
  Expression("ENTIRE_WORKTOP")
;`;
}

/**
 * The escrow `instantiate` deploy manifest, composed from the SHEET-GENERATED
 * spec (`@/lib/generated/instantiate-spec`, emitted from
 * `docs/ESCROW-PARAMETER-SHEET.md` §"PULL cutover").
 *
 * Lived inline in `/deploy-escrow/page.tsx` until P1-4, hand-typed. It was stale
 * twice — 12 args against a 13-arg blueprint, then against the 11-arg one DB-3
 * produced — and nothing caught either time: no type-checker reads a manifest
 * string, and no test covered that function. It now sits beside every other
 * builder, under the same test file.
 *
 * Why the values are generated rather than typed: the eleven args include FOUR
 * consecutive `u64`s and THREE `Decimal`s. Transposing a same-typed pair yields
 * a manifest that decodes cleanly, COMMITS, and misconfigures the component's
 * economics for its entire life — there are no setters. Arity mistakes are loud;
 * transpositions are silent, and they are what this exists to make impossible.
 *
 * ⚠️ Prefer the CLI at a real ceremony:
 *   bun scripts/gen-instantiate-manifest.mjs --package … --worker … --arbiter …
 *                                            --agent … --account …
 * It emits byte-identical text (asserted in tests/unit/escrow-instantiate-gate.test.ts)
 * and additionally compiles the result with the Radix Engine Toolkit — catching a
 * wrong address CHECKSUM, which the anchored regex below cannot — and prints the
 * royalty-admin badge custody note.
 */
export function instantiateEscrowManifest(
  escrowPackage: string,
  workerBadge: string,
  arbiterBadge: string,
  agentBadge: string | null,
  account: string,
  /**
   * The two CEREMONY args, in REWARD-TOKEN units.
   *
   * 🔴 The signed sheet carries `claim_bond_floor`/`cap` as USD POLICY
   * ($0.05 / $100) because the on-chain field is token-denominated and W4-mech
   * has no oracle — the conversion happens at the ceremony, at a rate the
   * runbook records. So the spec ships them with `literal: null` and there is
   * deliberately NO default here: a default would silently emit somebody's
   * guess at a rate into a write-once deploy. At XRD ~$0.0009 the intended
   * floor is ~55 XRD, and emitting the bare `0.05` would be off by roughly a
   * thousandfold with every other gate passing.
   *
   * The operator CLI enforces the USD policy independently (floor×rate and
   * cap×rate within 5% of the signed figures); this builder only refuses to
   * invent them.
   */
  ceremony?: { claimBondFloor: string; claimBondCap: string },
): string {
  const resolved: Record<string, string> = {
    worker_badge_resource: `Address("${validateAddress(workerBadge, "resource_rdx")}")`,
    arbiter_badge_resource: `Address("${validateAddress(arbiterBadge, "resource_rdx")}")`,
    agent_badge_resource:
      agentBadge === null
        ? "Enum<0u8>()"
        : `Enum<1u8>(Address("${validateAddress(agentBadge, "resource_rdx")}"))`,
    ...(ceremony
      ? {
          claim_bond_floor: `Decimal("${ceremony.claimBondFloor}")`,
          claim_bond_cap: `Decimal("${ceremony.claimBondCap}")`,
        }
      : {}),
  }
  const lines = INSTANTIATE_SPEC.map((a) => {
    const literal = a.literal ?? resolved[a.name]
    if (!literal) {
      // Name the class, so the operator is told WHAT is missing rather than
      // just that something is.
      const why =
        a.source === "ceremony"
          ? " — a CEREMONY arg: pass `ceremony` with the reward-token equivalents of the signed USD policy, converted at the rate the runbook records"
          : ""
      throw new Error(`no value for instantiate arg ${a.index} (${a.name})${why}`)
    }
    // The arg name rides in a comment because a bare positional list is
    // unreadable at a signing ceremony, and the operator is the last check.
    return `    ${literal}${" ".repeat(Math.max(1, 34 - literal.length))}# ${a.index}. ${a.name}`
  })
  return `CALL_FUNCTION
    Address("${validateAddress(escrowPackage, "package_rdx")}")
    "Escrow"
    "instantiate"
${lines.join("\n")}
;
CALL_METHOD
    Address("${validateAddress(account, "account_rdx")}")
    "try_deposit_batch_or_refund"
    Expression("ENTIRE_WORKTOP")
    Enum<0u8>()
;`
}
