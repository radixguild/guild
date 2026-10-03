/**
 * PULL entitlement events → ledger rows (redesign §5c).
 *
 * Under pull, `TaskState::Released` means the split is RECORDED, not that money
 * moved: funds sit in the component until each party withdraws. `TaskReleasedEvent`
 * still fires exactly as before — these two events are ADDITIVE, emitted alongside
 * it — so nothing here changes the existing lifecycle kinds. What is new is the
 * money question the old events can no longer answer: *has the party actually been
 * paid?*
 *
 *   SettlementCreditedEvent — how much each party is OWED, once per settlement.
 *   WithdrawalEvent         — a party COLLECTING, once per lane actually paid.
 *
 * ── Why these are NOT EscrowConfirmKinds ────────────────────────────────────────
 *
 * Every kind in escrow-confirm.ts advances `tasks.status` and is gated by
 * ALLOWED_FROM. Neither event here advances the lifecycle at all: a withdrawal
 * happens when the task is ALREADY paid/refunded/cancelled/open, and the chain
 * event is itself the proof it occurred. Putting them behind a status gate would
 * mean a real, committed withdrawal gets DROPPED because the DB row was in an
 * unexpected state — reporting all-clear on exactly the condition this ingestion
 * exists to observe. (That is the same regression shape §11b flags for chunk E.)
 *
 * So they are ledger-only: they write escrow_transactions rows and never touch
 * task status. This module is pure — no I/O, no DB — so the field decoding can be
 * tested exhaustively against fixture payloads.
 */

/** Which party a credit or withdrawal belongs to (blueprint `EntitledParty`). */
export type EntitlementParty = "worker" | "poster";
/** Which resource lane it moved (blueprint `EntitlementLane`). */
export type EntitlementLane = "reward" | "bond";

/** The two event names this module decodes, for the resync/reconciler scanners. */
export const ENTITLEMENT_EVENT_NAMES = [
  "SettlementCreditedEvent",
  "WithdrawalEvent",
] as const;
export type EntitlementEventName = (typeof ENTITLEMENT_EVENT_NAMES)[number];

export interface EntitlementLedgerRow {
  txType: "settle" | "withdraw";
  party: EntitlementParty;
  lane: EntitlementLane;
  /** Exact decimal string from the chain — never parsed through a JS float. */
  amountXrd: string;
  /** Payee pin, WithdrawalEvent only; null for settle rows. */
  destination: string | null;
}

type Field = { field_name?: string; value?: unknown; variant_name?: unknown };

function decimalField(fields: Field[], name: string): string | null {
  const v = fields.find((f) => f?.field_name === name)?.value;
  // Entitlements are non-negative by construction (the blueprint zeroes rather
  // than going negative), so a signed value is a shape we do not understand and
  // must not guess at.
  return typeof v === "string" && /^\d+(\.\d+)?$/.test(v) ? v : null;
}

function u64Field(fields: Field[], name: string): number | null {
  const v = fields.find((f) => f?.field_name === name)?.value;
  if (v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function enumVariantField(fields: Field[], name: string): string | null {
  const v = fields.find((f) => f?.field_name === name)?.variant_name;
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Blueprint `EntitledParty` → column value. Unknown variant = null (fail closed). */
function toParty(variant: string | null): EntitlementParty | null {
  if (variant === "Worker") return "worker";
  if (variant === "Poster") return "poster";
  return null;
}

/** Blueprint `EntitlementLane` → column value. Unknown variant = null (fail closed). */
function toLane(variant: string | null): EntitlementLane | null {
  if (variant === "Reward") return "reward";
  if (variant === "Bond") return "bond";
  return null;
}

/** The task id an entitlement event refers to, or null if unreadable. */
export function entitlementEventTaskId(fields: unknown): number | null {
  if (!Array.isArray(fields)) return null;
  return u64Field(fields as Field[], "task_id");
}

/**
 * SettlementCreditedEvent → one row per lane that is actually owed something.
 *
 * The event always reports all four amounts INCLUDING zeros (the blueprint is
 * explicit about that: `expire_claim` credits only the bond, so its reward lanes
 * read `{0, 0}` — "a settlement event stating that nothing settled"). A zero
 * entitlement is not a ledger fact, so zero lanes produce no row; the settlement
 * itself is already recorded by the legacy release/refund row.
 *
 * Returns [] for an unreadable payload rather than throwing — a malformed event
 * must not abort a resync that has real events after it. The caller distinguishes
 * "nothing owed" from "could not read" via {@link entitlementEventTaskId}.
 */
export function parseSettlementCreditedEvent(fields: unknown): EntitlementLedgerRow[] {
  if (!Array.isArray(fields)) return [];
  const f = fields as Field[];
  const lanes: { field: string; party: EntitlementParty; lane: EntitlementLane }[] = [
    { field: "worker_entitled", party: "worker", lane: "reward" },
    { field: "poster_entitled", party: "poster", lane: "reward" },
    { field: "worker_bond_entitled", party: "worker", lane: "bond" },
    { field: "poster_bond_entitled", party: "poster", lane: "bond" },
  ];
  const rows: EntitlementLedgerRow[] = [];
  for (const { field, party, lane } of lanes) {
    const amount = decimalField(f, field);
    if (amount === null) continue;
    if (Number(amount) === 0) continue;
    rows.push({ txType: "settle", party, lane, amountXrd: amount, destination: null });
  }
  return rows;
}

/**
 * WithdrawalEvent → exactly one row, or null if any required field is unreadable.
 *
 * ⚠️ `lane` is the discriminator and `resource` is bookkeeping — never the other
 * way round. `deposit_both_lanes` calls `take_lane` twice in ONE transaction, and
 * in production the reward token IS XRD, so a single `withdraw_worker` can emit
 * two events identical in (task_id, party, resource) and differing only in lane
 * and amount. Anything keying on the resource silently drops a leg. This is also
 * why the DB's uniqueness is (tx_hash, task_id, party, lane) — see the schema.
 *
 * Note a zero lane emits NO event at all (`take_lane` returns None before
 * emitting), so one withdraw tx yields ONE or TWO of these — never a zero row,
 * and never a guaranteed pair.
 */
export function parseWithdrawalEvent(fields: unknown): EntitlementLedgerRow | null {
  if (!Array.isArray(fields)) return null;
  const f = fields as Field[];
  const party = toParty(enumVariantField(f, "party"));
  const lane = toLane(enumVariantField(f, "lane"));
  const amountXrd = decimalField(f, "amount");
  if (!party || !lane || amountXrd === null) return null;
  const dest = f.find((x) => x?.field_name === "destination")?.value;
  return {
    txType: "withdraw",
    party,
    lane,
    amountXrd,
    destination: typeof dest === "string" && dest.length > 0 ? dest : null,
  };
}

/**
 * Decode either entitlement event by name. Returns [] for anything else, so a
 * scanner can call this on every event without knowing which are relevant.
 */
export function parseEntitlementEvent(
  eventName: string,
  fields: unknown,
): EntitlementLedgerRow[] {
  if (eventName === "SettlementCreditedEvent") return parseSettlementCreditedEvent(fields);
  if (eventName === "WithdrawalEvent") {
    const row = parseWithdrawalEvent(fields);
    return row ? [row] : [];
  }
  return [];
}

/**
 * Net position per party from a task's entitlement rows: credited minus collected.
 *
 * This is what makes DB `paid` honest again. A task can be `paid` with
 * `outstanding > 0` — settled on chain, money still in the component — and that
 * combination is precisely what the drift watcher (chunk E) and the withdraw UI
 * (chunk G) need to see. Exact decimal-string arithmetic via BigInt at 18dp: the
 * amounts are money and must never round-trip through a float.
 */
export function netEntitlements(
  rows: readonly Pick<EntitlementLedgerRow, "txType" | "party" | "amountXrd">[],
): Record<EntitlementParty, { credited: string; collected: string; outstanding: string }> {
  const acc: Record<string, { credited: bigint; collected: bigint }> = {
    worker: { credited: ZERO, collected: ZERO },
    poster: { credited: ZERO, collected: ZERO },
  };
  for (const r of rows) {
    const bucket = acc[r.party];
    if (!bucket) continue;
    const scaled = scale18(r.amountXrd);
    if (scaled === null) continue;
    if (r.txType === "settle") bucket.credited += scaled;
    else if (r.txType === "withdraw") bucket.collected += scaled;
  }
  const out = {} as Record<
    EntitlementParty,
    { credited: string; collected: string; outstanding: string }
  >;
  for (const party of ["worker", "poster"] as const) {
    const { credited, collected } = acc[party];
    out[party] = {
      credited: unscale18(credited),
      collected: unscale18(collected),
      outstanding: unscale18(credited - collected),
    };
  }
  return out;
}

// BigInt LITERALS (`0n`) need target ES2020; this app targets ES2017, and the
// existing exact-decimal helper in manifests.ts uses the constructor form for the
// same reason. Same convention here rather than a second one.
const ZERO = BigInt(0);

/** Decimal string → 18dp scaled BigInt. null if not a plain non-negative decimal. */
function scale18(v: string): bigint | null {
  if (!/^\d+(\.\d+)?$/.test(v)) return null;
  const [whole, frac = ""] = v.split(".");
  return BigInt(whole + frac.padEnd(18, "0").slice(0, 18));
}

/**
 * 18dp scaled BigInt → decimal string, trailing zeros trimmed. Same 18dp
 * unscaling the manifest builders use for exact Decimal math, extended for a
 * negative result:
 * `outstanding` is a subtraction, and although the blueprint makes over-collection
 * impossible (take_lane zeroes the entitlement before paying), a negative here
 * would mean the ledger disagrees with the chain — it must render as a visible
 * negative, never silently as its absolute value.
 */
function unscale18(scaled: bigint): string {
  const neg = scaled < ZERO;
  const digits = (neg ? -scaled : scaled).toString().padStart(19, "0");
  const out = `${digits.slice(0, -18)}.${digits.slice(-18)}`.replace(/\.?0+$/, "");
  return `${neg && out !== "0" ? "-" : ""}${out === "" ? "0" : out}`;
}
