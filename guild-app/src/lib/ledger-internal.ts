// Internal-cycle LABELLING for the public /ledger page — the disclosed twin of
// the leaderboard's GUILD_TEST_ACCOUNTS exclusion (src/lib/test-accounts.ts).
//
// Why labelled and not hidden: two operator accounts carry ~250 of the ~260
// address appearances on the ledger. Hidden, that is a page that quietly
// under-reports; discovered, it reads as wash trading. Disclosed, it is what it
// actually is — proof the settlement machinery works, and NOT evidence of
// outside demand. So every row stays on the page, and the rows whose
// participants are Guild-operated test accounts carry a visible label plus a
// summary line saying how many there are.
//
// Where the allowlist lives: the same server-only GUILD_TEST_ACCOUNTS env
// the leaderboard already reads. Empty/unset => nothing is labelled (safe
// default; CI has no env). Only the per-row boolean and the counts ever leave
// the server — never the address list.
//
// Pure functions, no I/O: the page (a React Server Component) calls them with
// the rows it fetched and the allowlist it read; tests call them directly.

/** The two account fields a ledger row carries — the poster's account and the
 *  payee/counterparty (nullable: a dispute marker has no `to`, and a settle
 *  leg for a worker whose claim was never recorded resolves to null). Both are
 *  Radix account addresses (users.id). */
export interface LedgerParticipants {
  fromUserId: string
  toUserId: string | null
}

export type LedgerRowOrigin = "internal" | "external"

/**
 * A row is INTERNAL when ANY participating account is a declared
 * Guild-operated test account — poster, payee, or both. "Any side" rather
 * than "both sides" is deliberate: it is the conservative direction. A row
 * with a Guild account on one side still contributed to the address
 * concentration a stranger will notice, and disclosing it costs nothing;
 * failing to disclose it is exactly the "discovered, not disclosed" failure
 * this exists to prevent. The copy that accompanies the label says "at least
 * one side" for the same reason — it must stay true for the one-sided rows.
 *
 * With an empty allowlist nothing is internal, by construction.
 *
 * ⚠️ MUST agree with the SQL predicate in `countLedgerEvents`
 * (src/db/queries/escrow.ts) — `from_user_id IN (…) OR to_user_id IN (…)`.
 * tests/integration/ledger-pagination.pg.test.ts pins the two to each other
 * against real Postgres, so a change to one without the other reddens.
 */
export function classifyLedgerRow(
  row: LedgerParticipants,
  testAccounts: readonly string[],
): LedgerRowOrigin {
  if (testAccounts.length === 0) return "external"
  if (testAccounts.includes(row.fromUserId)) return "internal"
  if (row.toUserId !== null && testAccounts.includes(row.toUserId)) return "internal"
  return "external"
}

// ── Copy ─────────────────────────────────────────────────────────────────────
// Kept here as constants + one pure function so the strings a reader sees are
// pinned by unit tests and swept by the honest-copy gate over the rendered
// page (scripts/honest-copy.mjs — /ledger is in DYNAMIC_ROUTES). None of it
// claims "verified", "audited", "trustless" or a guarantee: the label describes
// who was on each side of a real on-chain event, and nothing more.

/** Per-row badge text. */
export const INTERNAL_CYCLE_LABEL = "internal test cycle"

/** Per-row badge tooltip (`title`) — the honest definition of the label. */
export const INTERNAL_CYCLE_TITLE =
  "A Guild-operated test account is on at least one side of this event (poster, payee or both). " +
  "It shows the settlement machinery working; it does not by itself show outside demand."

export interface LedgerInternalCounts {
  /** Every event the ledger holds (same filter as the feed: confirmed, hashed, settlement kinds). */
  total: number
  /** Those with a declared Guild-operated test account on at least one side. */
  internal: number
}

/**
 * The summary line rendered above the table. `declared` is whether ANY test
 * account is declared (GUILD_TEST_ACCOUNTS non-empty).
 *
 * The undeclared branch is the load-bearing one. With no allowlist the page
 * cannot tell an internal row from an external one, so it must NOT print
 * "0 of N are internal" — on a deployment that simply forgot the env, that
 * would be a false denial, worse than today's silence. Instead it says
 * plainly that nothing is labelled here and that an unlabelled row proves
 * nothing either way. That is also what CI (no env, empty DB) renders.
 */
export function ledgerInternalSummary(counts: LedgerInternalCounts, declared: boolean): string {
  const { total, internal } = counts

  if (!declared) {
    return (
      "Internal test cycles are not labelled on this deployment: no Guild-operated test accounts " +
      "are declared, so no row here carries the label. An unlabelled row is not thereby external."
    )
  }

  if (total === 0) {
    return (
      "Nothing recorded yet, so nothing to label. When events land, any with a Guild-operated " +
      "test account on either side is labelled an internal test cycle here — shown, not hidden."
    )
  }

  // The none and mixed branches end with the undeclared branch's own sentence
  // (2026-09-24): the label is a LOWER BOUND. It marks the rows whose accounts
  // the operator has declared; a Guild-operated account left out of the env
  // leaves its rows unlabelled, and without this sentence an unlabelled row
  // reads as outside activity. Said this way, the line stays true however
  // complete the declared list is.
  if (internal === 0) {
    return (
      `None of the ${total} events on this ledger are labelled internal test cycles — no declared ` +
      "Guild-operated test account is on either side of any of them. An unlabelled row is not " +
      "thereby external."
    )
  }

  const plural = (n: number) => (n === 1 ? "event" : "events")

  if (internal === total) {
    return (
      `All ${total} ${plural(total)} on this ledger so far are internal test cycles — a Guild-operated ` +
      "test account is on at least one side of each. They are shown, not hidden: the machinery is " +
      "real; the demand is not yet."
    )
  }

  const external = total - internal
  return (
    `${internal} of ${total} events on this ledger are internal test cycles — a Guild-operated test ` +
    "account is on at least one side. They are shown, not hidden: they show the machinery working, " +
    `not demand. The other ${external} ${plural(external)} ${external === 1 ? "involves" : "involve"} ` +
    "no declared Guild-operated test account. An unlabelled row is not thereby external."
  )
}
